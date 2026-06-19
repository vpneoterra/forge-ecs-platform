/**
 * ForgeOmniStack -- OMNI PicoGK Fountain Pen Generator
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and Fargate service. Does NOT depend on ForgeComputeStack.
 *
 * Route 53 integration:
 *   - ACM certificate with automated DNS validation via Route 53
 *   - A/AAAA Alias records pointing to the ALB (auto-follow ALB IP changes)
 *   - No manual DNS updates ever needed -- Route 53 handles everything
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed) + $0.008/LCU-hour
 *   - Fargate (4096 CPU / 16384 MB): ~$70/month (on-demand)
 *   - Secrets Manager: imported (managed outside this stack)
 *   - CloudWatch Logs: ~$0.50/month (7-day retention)
 *   - Route 53 hosted zone: $0.50/month + $0.40/million queries
 *   - ACM certificate: free
 *   Total: ~$88/month
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { resolveEcrImage } from './image-ref';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { vpcSecondOctet } from './config/network-config';

export interface ForgeOmniStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'omni.qrucible.ai'
  hostedZoneDomain: string; // e.g., 'qrucible.ai'
  /**
   * Whether this stack OWNS the production omni.qrucible.ai Route 53 alias.
   * Only one env may own it at a time (CloudFormation cannot CREATE a record
   * set another stack already declares). Set false on the outgoing env during a
   * blue/green cutover so the record is dropped here and CloudFormation DELETEs
   * it, freeing the name for the incoming env. Defaults true.
   */
  claimProdDomain?: boolean;
  tags?: Record<string, string>;
}

export class ForgeOmniStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: ForgeOmniStackProps) {
    super(scope, id, props);

    const env = props.forgeEnv;

    // -- Route 53 Hosted Zone (lookup existing) --------------------------------
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- ECS Cluster (Fargate only -- no EC2 instances needed) ---------------
    this.ecsCluster = new ecs.Cluster(this, 'OmniCluster', {
      clusterName: `omni-${env}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false,
    });

    // -- ECR Repository (import existing) ------------------------------------
    // The omni-dev2 burst fleet runs the SAME OMNI build as the warm `forge-omni`
    // floor. CI (forgenew build-image.yml -> omni_repo=forge-omni-dev2 for the
    // dev2/prod suffix; push-omni-from-hetzner.yml) pushes current OMNI to
    // `forge-omni-dev2` (tags :latest + full git-SHA). The legacy `omni` repo is
    // DEAD (last push 2026-03-29) -- pointing here meant the burst fleet would
    // pull a stale image divergent from the warm floor. Live omni:20/21 already
    // pull forge-omni-dev2:latest; this aligns CDK with that reality so a future
    // `cdk deploy` cannot regress the fleet back onto the dead repo.
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'OmniRepo', 'forge-omni-dev2',
    );

    // -- Secrets --------------------------------------------------------------
    const omniApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SecretOmniApiKey', `forge/${env}/omni-api-key`,
    );

    // KEYSTONE (HuggingFace provider) secrets -- shared across environments and
    // therefore live under `forge/test/*` (not the env-scoped path used above).
    // The OMNI .NET binary (`docker/omni/src/Services/Keystone/ClaudeApiService.cs`)
    // requires BOTH a non-empty `_apiKey` (HF token) and a non-empty `_hfBaseUrl`
    // (HF endpoint URL) for `IsConfigured` to flip true when `KEYSTONE_PROVIDER=huggingface`.
    // Without these the previously-good HF endpoint receives 0 calls (see
    // KEYSTONE_ZERO_CALLS_REPORT.md). KEYSTONE must use the HuggingFace path,
    // not Claude.
    const keystoneHfTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SecretKeystoneHfToken', 'forge/test/keystone-hf-token',
    );
    const keystoneHfEndpointSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SecretKeystoneHfEndpoint', 'forge/test/keystone-hf-endpoint',
    );

    // Shared FORGE Supabase Postgres connection for the CLAIMABLE render queue
    // (omni.render_jobs, forgenew migration 531/540). The render worker
    // (BomRenderWorker) is INERT unless this is set (Program.cs selects the
    // Postgres claimable store only when JOBS_DB_CONNECTION_STRING is present;
    // otherwise it falls back to a local Sqlite store with no shared queue), and
    // RenderMetricsPublisher only publishes OMNI/Render metrics when the store is
    // claimable. The live omni:20/21 taskdefs already inject this secret; CDK
    // omitted it, so a `cdk deploy` would have silently disabled the shared queue
    // (and with it all backlog-based autoscaling). Must use the TRANSACTION-mode
    // pooler endpoint (OmniPoolerGuard asserts this at startup).
    const jobsDbSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SecretJobsDbConnectionString', `forge/${env}/jobs-db-connection-string`,
    );

    const secrets: Record<string, ecs.Secret> = {
      API_KEY: ecs.Secret.fromSecretsManager(omniApiKeySecret),
      KEYSTONE_HF_TOKEN: ecs.Secret.fromSecretsManager(keystoneHfTokenSecret),
      KEYSTONE_HF_ENDPOINT: ecs.Secret.fromSecretsManager(keystoneHfEndpointSecret),
      // Enables the claimable Postgres render queue + metrics publication.
      JOBS_DB_CONNECTION_STRING: ecs.Secret.fromSecretsManager(jobsDbSecret),
    };

    // -- CloudWatch Log Group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'OmniLogGroup', {
      logGroupName: '/forge/ecs/omni',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -- Task Execution Role --------------------------------------------------
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/${env}/*`,
        // KEYSTONE HF secrets are shared across envs and live in forge/test/*.
        // Scope is intentionally narrow (only the two specific secret names
        // with their wildcard suffixes) to avoid widening to all of forge/test/*.
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/test/keystone-hf-token-*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/test/keystone-hf-endpoint-*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/forge/*`],
    }));
    ecrRepo.grantPull(executionRole);

    // -- Task Role (runtime) --------------------------------------------------
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // -- Fargate Task Definition ----------------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, 'OmniTaskDef', {
      family: 'omni',
      cpu: 4096,
      memoryLimitMiB: 16384,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Immutable image pin via CDK context (see lib/image-ref.ts). The burst fleet
    // shares the SAME context prefix as the warm `forge-omni` floor so a single
    // pin rolls BOTH services to the identical build in lock-step:
    //   -c forgeOmniImageDigest=sha256:...   (preferred -- immutable, rolls ECS)
    //   -c forgeOmniImageTag=<git-sha>
    // Falls back to ':latest' when no override is supplied. NOTE: a mutable
    // ':latest' does NOT trigger an ECS rollout (the task-definition text is
    // unchanged), so CI MUST pass `-c forgeOmniImageDigest=<digest>` at deploy
    // for new OMNI pushes to actually roll onto running tasks.
    const container = taskDef.addContainer('omni-api', {
      image: resolveEcrImage(this, ecrRepo, 'forgeOmni'),
      essential: true,
      // STOP/DRAIN: a render runs for MINUTES and the worker drains in-flight work
      // within OMNI_RENDER_DRAIN_SECONDS (default 110s) on SIGTERM. The ECS
      // default stopTimeout is 30s, which SIGKILLs the container mid-render on
      // every scale-in or rolling deploy -- throwing away minutes of work and
      // forcing a lease reclaim. 120s gives the worker its full drain window
      // (must be > OMNI_RENDER_DRAIN_SECONDS) before the agent escalates to
      // SIGKILL. Pairs with the ALB deregistrationDelay below (130s) so the
      // target stops receiving new requests while the active render drains.
      stopTimeout: cdk.Duration.seconds(120),
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        OMNI_DOMAIN: props.domainName,
        // FluxTK + enrichment bridge service discovery. Both targets live in
        // private Cloud Map zones already attached to this VPC -- no extra
        // DNS work needed here. Keep these in sync with forge-app-stack.ts.
        // RCA: FluxTK_ServiceDiscovery_RCA.md (2026-05-28).
        FluxTK__BaseUrl: 'http://forge-fluxtk.forge-geometry.local:8040',
        ENRICHMENT_BRIDGE_URL:
          'http://forge-app-test.forge.local:3000/api/omni-enriched',
        // KEYSTONE provider selection -- HuggingFace path (NOT Claude/Anthropic).
        // Default in `ClaudeApiService.cs` is also 'huggingface'; set explicitly
        // so the live task definition reflects intent and a future rollback to
        // 'anthropic' is a one-line CDK edit. Keep in sync with forge-app-stack.ts.
        KEYSTONE_PROVIDER: 'huggingface',
        // -- RENDER QUEUE / SCALING / DRAIN enablers ---------------------------
        // Turn ON the BomRenderWorker's CloudWatch metric publication so the
        // OMNI/Render namespace (QueueDepth, RunningJobs, BacklogPerTask, ...) is
        // populated. The native step-scaling policy below AND the warm-floor
        // controller Lambda both depend on these metrics; without OMNI_METRICS=on
        // nothing is published and backlog-based scale-out is blind.
        OMNI_METRICS: 'on',
        // Hold ECS task scale-in protection while a render is in flight (renders
        // run for MINUTES). Without this, scale-in/rolling deploys can terminate a
        // task mid-render despite the stopTimeout/deregistrationDelay drain window.
        // The worker talks to the LOCAL ECS agent endpoint (ECS_AGENT_URI), so this
        // needs NO extra task-role IAM -- it is task-local and self-expiring.
        OMNI_TASK_PROTECTION: 'on',
        // Dimension value for OMNI/Render metrics. Must match the ECS service name
        // (`omni-${env}`) so CloudWatch metrics, the step-scaling policy, and the
        // controller Lambda all key off the same ServiceName dimension.
        OMNI_SERVICE_NAME: `omni-${env}`,
      },
      secrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'omni',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:5000/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({ containerPort: 5000 });

    // -- ALB requires 2 AZs -- ensure we have enough public subnets -----------
    let albSubnets: ec2.ISubnet[] = [...props.publicSubnets];
    if (albSubnets.length < 2) {
      const usedAz = albSubnets[0].availabilityZone;
      const allAzs = cdk.Stack.of(this).availabilityZones;
      const secondAz = allAzs.find(az => az !== usedAz) ?? allAzs[1] ?? `${this.region}b`;

      const albSubnet2 = new ec2.PublicSubnet(this, 'AlbSubnet2', {
        vpcId: props.vpc.vpcId,
        cidrBlock: `10.${vpcSecondOctet(env)}.129.0/24`,
        availabilityZone: secondAz,
        mapPublicIpOnLaunch: true,
      });
      const igwId = props.vpc.internetGatewayId!;
      albSubnet2.addDefaultInternetRoute(igwId, props.vpc.internetConnectivityEstablished);
      albSubnets.push(albSubnet2);
    }

    // -- Application Load Balancer --------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'OmniAlb', {
      loadBalancerName: 'omni-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnets: albSubnets },
      idleTimeout: cdk.Duration.seconds(600),
    });

    // -- ACM Certificate (DNS validated via Route 53 -- fully automatic) ------
    const certificate = new acm.Certificate(this, 'OmniCert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // HTTPS listener (primary)
    const httpsListener = this.alb.addListener('Https', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    });

    // HTTP listener -- redirect to HTTPS
    this.alb.addListener('Http', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // -- Route 53 Alias Record ------------------------------------------------
    // Gated on claimProdDomain so exactly one env owns the prod alias: during a
    // blue/green cutover the outgoing env deploys with claimProdDomain=false,
    // dropping this record so CloudFormation DELETEs it and frees the name.
    if (props.claimProdDomain ?? true) {
      new route53.ARecord(this, 'OmniAlbAlias', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(this.alb),
        ),
        comment: 'OMNI app ALB -- managed by CDK',
      });
    }

    // -- Fargate Service -------------------------------------------------------
    const service = new ecs.FargateService(this, 'OmniService', {
      cluster: this.ecsCluster,
      taskDefinition: taskDef,
      // BURST TIER: omni-${env} is the elastic overflow fleet, NOT the warm
      // baseline. The always-warm OMNI floor is `forge-omni` (forge-app-stack.ts,
      // desiredCount:1 on Fargate, host-header routed at omni.qrucible.ai), which
      // stays up 24/7 and is unaffected by the daily green/geometry cluster
      // parking. This service therefore starts at ZERO and only scales out on
      // real render backlog, so it costs nothing when idle.
      desiredCount: 0,
      serviceName: `omni-${env}`,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
    });

    this.serviceName = `omni-${env}`;

    // Register with ALB target group
    const omniTargetGroup = httpsListener.addTargets('OmniTarget', {
      targets: [service],
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyHttpCodes: '200',
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      // STOP/DRAIN: hold the target in `draining` long enough for an in-flight
      // render (minutes) to finish its drain window before the ALB forcibly
      // closes connections. Must be >= container stopTimeout (120s). 130s gives
      // a small margin over the 120s stopTimeout so the container-level drain
      // completes first. Combined with ECS task scale-in protection (the worker
      // holds protection via the local ECS agent endpoint while a render runs),
      // this lets scale-in/deploys retire a task only once it is truly idle.
      deregistrationDelay: cdk.Duration.seconds(130),
    });

    // -- Service auto scaling (burst tier, scale-to-zero) ----------------------
    // This fleet is the BURST tier on top of the always-warm `forge-omni` floor.
    // It scales 0 -> 3 on render backlog so we never pay for idle compute, and
    // returns to 0 when the queue drains. The warm floor (1 task) is provided by
    // forge-omni, so OMNI is always reachable even at min 0 here.
    //
    // TWO cooperating controls (they do NOT fight -- one sets the FLOOR, the
    // other does the elastic step scaling within [floor, max]):
    //
    //   1) NATIVE step scaling (this block) -- primary scale-out/in on the
    //      published OMNI/Render -> BacklogPerTask signal (queued jobs per running
    //      task). It reacts within [minCapacity, maxCapacity].
    //
    //   2) WARM-FLOOR controller Lambda (below) -- a 1-minute EventBridge tick
    //      reads the AUTHORITATIVE queue depth straight from the shared Postgres
    //      render queue (omni.render_jobs) and RAISES minCapacity (the floor) so
    //      the fleet can scale out FROM ZERO. The native BacklogPerTask metric is
    //      blind at desiredCount=0 (no task is running to publish it), so without
    //      the Lambda the fleet could never leave zero. The Lambda only adjusts
    //      the scalable-target floor via RegisterScalableTarget; it never writes
    //      desiredCount, so Application Auto Scaling never reverts it (per AWS
    //      docs, a manual UpdateService desiredCount WOULD be reverted by an
    //      active policy -- the floor approach sidesteps that entirely).
    //
    // FAST SCALE-IN: when the queue clears, the Lambda drops the floor back to 0
    // and the native policy scales in promptly (short cooldown). This is SAFE
    // despite long renders because the worker holds ECS task scale-in protection
    // for the duration of each render (OMNI_TASK_PROTECTION=on) -- the scheduler
    // will not terminate a task that is actively rendering, even when the desired
    // count drops. So idle tasks retire fast while in-flight work is preserved.
    const scaling = service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: 3 });

    scaling.scaleOnMetric('OmniBacklogPerTaskScaling', {
      metric: new cloudwatch.Metric({
        namespace: 'OMNI/Render',
        metricName: 'BacklogPerTask',
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      // Step scaling: backlog 0 -> scale IN by 1 (retire idle tasks quickly;
      // protected in-flight renders are NOT killed). backlog >= 1 -> add a task;
      // deeper backlog -> add more, up to maxCapacity. The explicit negative step
      // at the bottom is what makes container count come down quickly once work
      // is delivered/drained, rather than lingering.
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 1, change: +1 },
        { lower: 3, change: +2 },
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      // Short cooldown so scale-in happens promptly once the backlog clears.
      // Task scale-in protection (not cooldown) is what guards active renders, so
      // a short cooldown here does not risk killing in-flight work.
      cooldown: cdk.Duration.seconds(60),
      evaluationPeriods: 1,
    });

    // Reference the target group so the symbol is retained for future
    // request-based policies; backlog is the primary burst signal.
    void omniTargetGroup;

    // -- Warm-floor controller Lambda (scale-out FROM ZERO) --------------------
    // See the autoscaling comment above for why this exists: at desiredCount=0
    // no task publishes BacklogPerTask, so the native policy can never leave
    // zero on its own. This Lambda ticks every minute, reads the queue depth
    // directly from the shared Postgres render queue (the same omni.render_jobs
    // table + the same queued/running definition the worker uses), computes a
    // desired FLOOR, and pushes it via RegisterScalableTarget.
    //
    // Floor math (SLOTS=1, so one task serves one render at a time):
    //   need  = QueueDepth + RunningJobs            // total live work units
    //   floor = clamp(need - WARM_SLOTS, 0, MAX)    // warm forge-omni absorbs 1
    // WARM_SLOTS=1 reflects the always-on forge-omni floor that handles the
    // first unit of work; MAX is the scalable-target maxCapacity (3) so the
    // floor can never exceed the fleet cap. When need <= WARM_SLOTS the floor is
    // 0 and the native policy is free to scale the burst fleet back to zero.
    const controllerFn = new lambda.Function(this, 'OmniScaleFloorController', {
      functionName: `omni-scale-floor-controller-${env}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      // Python 3.12 asset (matches lambda/harness-auto-pause). boto3 is in the
      // managed runtime; the only vendored dependency is the PURE-PYTHON Postgres
      // driver pg8000 (+ its pure-python deps) committed under the asset dir, so
      // no Docker bundling / native build is needed. The handler runs ONE
      // read-only COUNT query against omni.render_jobs.
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'omni-scale-floor-controller')),
      timeout: cdk.Duration.seconds(20),
      memorySize: 128,
      environment: {
        OMNI_SERVICE_NAMESPACE: 'ecs',
        OMNI_SCALABLE_RESOURCE_ID: `service/${this.ecsCluster.clusterName}/omni-${env}`,
        OMNI_SCALABLE_DIMENSION: 'ecs:service:DesiredCount',
        OMNI_MAX_TASKS: '3',
        OMNI_WARM_SLOTS: '1',
        OMNI_JOBS_DB_SECRET_ARN: jobsDbSecret.secretArn,
        OMNI_RENDER_TABLE: 'omni.render_jobs',
      },
    });

    // IAM: read the queue-DB connection secret, read+set the scalable target.
    jobsDbSecret.grantRead(controllerFn);
    controllerFn.addToRolePolicy(new iam.PolicyStatement({
      // application-autoscaling has no resource-level scoping for these actions;
      // they are account/region-wide read+register on scalable targets. We keep
      // the action set minimal (describe + register only).
      actions: [
        'application-autoscaling:DescribeScalableTargets',
        'application-autoscaling:RegisterScalableTarget',
      ],
      resources: ['*'],
    }));

    // 1-minute EventBridge tick.
    const controllerSchedule = new events.Rule(this, 'OmniScaleFloorSchedule', {
      ruleName: `omni-scale-floor-${env}`,
      description: 'Tick the OMNI burst warm-floor controller every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });
    controllerSchedule.addTarget(new eventsTargets.LambdaFunction(controllerFn, {
      retryAttempts: 1,
    }));

    // Controller log group (3-day retention -- short-lived operational logs).
    new logs.LogGroup(this, 'OmniScaleFloorControllerLogGroup', {
      logGroupName: `/aws/lambda/omni-scale-floor-controller-${env}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -- Outputs ---------------------------------------------------------------
    this.albDnsName = new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name (Route 53 Alias handles this -- no manual CNAME needed)',
      exportName: `OmniAlbDns-${env}`,
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'ALB ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for omni images',
      exportName: `OmniEcrUri-${env}`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS service name',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: `OmniClusterName-${env}`,
    });

    new cdk.CfnOutput(this, 'DomainSetup', {
      value: `Route 53 Alias: ${props.domainName} -> ALB (automatic, no manual DNS needed)`,
      description: 'DNS is fully managed by Route 53 + CDK',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'ACM certificate ARN (auto-validated via Route 53)',
    });
  }
}
