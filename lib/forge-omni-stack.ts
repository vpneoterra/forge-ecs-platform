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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import { Construct } from 'constructs';
import { vpcSecondOctet } from './config/network-config';
import {
  OMNI_BACKLOG_NAMESPACE,
  OMNI_BACKLOG_METRIC_NAME,
  OMNI_BACKLOG_PER_TASK_METRIC_NAME,
  OMNI_BACKLOG_PER_TASK_TARGET,
  OMNI_BACKLOG_SERVICE_DIMENSION,
} from './config/omni-backlog-metric';
import {
  OMNI_FACET2_SHARED_ENV,
  applyOmniMeshContract,
} from './config/omni-mesh-contract';

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

    // -- ECR Repository (OWNED -- RC2-A/RC2-D/RC2-E) -------------------------
    // This standalone stack IS the OMNI scale-out fleet (`omni-${env}` service ->
    // forge-omni-dev2 at env=dev2). RC2 traced the entire program-window outage to
    // how this fleet's ECR repo was configured out-of-band:
    //   - imageTagMutability=MUTABLE  -> a `:latest` push silently overwrote the
    //     digest a live deployment pinned (RC2-A).
    //   - lifecycle "keep 5 tagged + expire untagged after 3 days" -> the digest a
    //     RUNNING deployment referenced was GC'd once a newer `:latest` push left
    //     the old one untagged, yielding CannotPullContainerError (RC2-D/RC2-E).
    // The structural fix is to make CDK OWN the repo so these guarantees are
    // codified and version-controlled, not set by hand:
    //   - imageTagMutability = IMMUTABLE: a tag, once pushed, cannot be overwritten.
    //   - lifecycle expires ONLY genuinely unreferenced UNTAGGED images, and never
    //     deletes a tagged build image by count (no maxImageCount sweep that could
    //     remove a digest an active task-def still pins). Combined with digest-
    //     pinned deploys (resolveEcrImage requires @sha256/immutable tag) the
    //     "expired out from under a running deployment" path is closed.
    //   - removalPolicy RETAIN: never destroy the image store on stack delete.
    //
    // DEPLOY NOTE: the repo `forge-omni-${env}` already exists in AWS (created
    // out-of-band). Adopt it into this stack with `cdk import` (CloudFormation
    // import) so this OWNED definition takes over its configuration without a
    // destroy/recreate. After import, every subsequent deploy enforces IMMUTABLE +
    // the pin-safe lifecycle below.
    const ecrRepo = new ecr.Repository(this, 'OmniRepo', {
      repositoryName: `forge-omni-${env}`,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Expire ONLY untagged images (orphaned manifest layers from replaced
          // immutable tags). Tagged build images are never age- or count-expired,
          // so a digest an active task-def revision pins is never GC'd. 14 days is
          // ample slack for a tag to be superseded and fully unreferenced before
          // its now-untagged layers are reclaimed; it is NOT a window the in-use
          // path depends on (digest-pinned deploys + IMMUTABLE close that path).
          rulePriority: 1,
          description: 'Expire untagged (orphaned) images after 14 days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(14),
        },
      ],
    });

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

    const secrets: Record<string, ecs.Secret> = {
      API_KEY: ecs.Secret.fromSecretsManager(omniApiKeySecret),
      KEYSTONE_HF_TOKEN: ecs.Secret.fromSecretsManager(keystoneHfTokenSecret),
      KEYSTONE_HF_ENDPOINT: ecs.Secret.fromSecretsManager(keystoneHfEndpointSecret),
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

    // -- S3: OMNI render artifacts (GLB/STL) under renders/* ------------------
    // The OMNI render fleet (BomRenderWorker) persists each rendered GLB/STL to
    // s3://forge-omni-artifacts-<account>-<region>/renders/<...>. Without this
    // grant every per-part PutObject returns AccessDenied -> OMNI produces zero
    // GLBs -> declares GeometryEmpty -> never returns a source_model_url -> the
    // W6 geometry-lock predicate (with_source_model_url > 0) can never pass.
    // This self-contained OMNI deployment runs the same render workload under
    // its own task role, so the grant is mirrored here. Least privilege: only
    // the multipart-upload object actions the render path performs, scoped to
    // the renders/* prefix (NOT the whole bucket, NOT s3:*, NOT all buckets).
    const omniArtifactsBucket = `forge-omni-artifacts-${this.account}-${this.region}`;
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OmniArtifactsRendersWrite',
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
        's3:GetObject',
      ],
      resources: [`arn:aws:s3:::${omniArtifactsBucket}/renders/*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OmniArtifactsList',
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [`arn:aws:s3:::${omniArtifactsBucket}`],
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

    // Immutable image pin via CDK context (see lib/image-ref.ts):
    //   -c omniImageDigest=sha256:...   (preferred)
    //   -c omniImageTag=<git-sha>
    // Falls back to ':latest' when no override is supplied.
    const container = taskDef.addContainer('omni-api', {
      image: resolveEcrImage(this, ecrRepo, 'omni'),
      essential: true,
      // [RC#2 4270137b 2026-06-19] Container-level hard memory limit. Root cause
      // amplifier of the OMNI exit-137 crash-loop: the omni-api container had NO
      // memory / memoryReservation (only the task-level 16384 MB), so when the
      // SdfShapeRouter built an unbounded multi-GB placeholder mesh the cgroup
      // OOM-killer scoped to the whole TASK and it died before delivering any
      // terminal render callback (omni_task_died_before_terminal). An explicit
      // container limit (a) scopes the OOM to the container so the platform
      // restarts cleanly, and (b) gives the SdfRouter vertex-ceiling (the code
      // half of RC#2) a real byte budget to size against. Set just under the
      // task limit (16384) to leave headroom for the agent/log sidecar overhead;
      // omni-api is the only essential container in this task.
      memoryLimitMiB: 15360,
      environment: {
        // ── Shared OMNI FACET2 mesh contract (single source of truth) ────────
        // FACET2_OMNI_GUARD=true, OMNI_MESH_ARTIFACTS_ROOT=/var/facet2/mesh, and
        // FluxTK__BaseUrl are spread from lib/config/omni-mesh-contract.ts — the
        // SAME source the green OMNI task def (lib/forge-app-stack.ts) consumes.
        //
        // Before this, the scalable-pool task def (omni:25) had NONE of this
        // wiring: FACET2_OMNI_GUARD and OMNI_MESH_ARTIFACTS_ROOT were UNSET and
        // the mesh EFS was unmounted, so on run atlas-41ce3232-pressure-hull the
        // pool could not read FACET2-authored meshes AND did not enforce the
        // kernel guard — class=SHELL parts fell into the voxel path and failed
        // with EmptyMeshException (5/5 SHELL failures). Spread FIRST so no later
        // key shadows a shared-contract key; a parity test
        // (test/forge-omni-facet2-parity.test.ts) fails the build on any drift
        // between this task def and green.
        ...OMNI_FACET2_SHARED_ENV,
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        OMNI_DOMAIN: props.domainName,
        // Enrichment bridge service discovery. Lives in a private Cloud Map zone
        // already attached to this VPC -- no extra DNS work needed here.
        ENRICHMENT_BRIDGE_URL:
          'http://forge-app-test.forge.local:3000/api/omni-enriched',
        // KEYSTONE provider selection -- HuggingFace path (NOT Claude/Anthropic).
        // Default in `ClaudeApiService.cs` is also 'huggingface'; set explicitly
        // so the live task definition reflects intent and a future rollback to
        // 'anthropic' is a one-line CDK edit. Keep in sync with forge-app-stack.ts.
        KEYSTONE_PROVIDER: 'huggingface',
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

    // -- Shared OMNI FACET2 mesh wiring (single source of truth) --------------
    // Mounts the pre-existing FACET2 mesh-blob-store EFS read-only at
    // OMNI_MESH_ARTIFACTS_ROOT and grants the matching read-only ClientMount,
    // using the SAME helper green (lib/forge-app-stack.ts) calls. Before this,
    // the scalable-pool task def (omni:25) had no mesh mount, so OMNI could not
    // read FACET2-authored meshes on run atlas-41ce3232-pressure-hull.
    //
    // No SG change is needed: this service runs under the shared ECS task SG
    // (props.ecsSecurityGroup, same as green/FACET2) and the EFS mount-target SG
    // already permits NFS:2049 self-referentially. If this service is ever moved
    // to a different SG the mount will fail at runtime — that must be fixed by
    // adding the 2049 ingress, never by skipping this wiring.
    applyOmniMeshContract(this, taskDef, container, taskRole);

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
      desiredCount: 1,
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
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // -- Service auto scaling --------------------------------------------------
    // omni does high-load 3D asset generation; scale OUT on CPU and ALB
    // request rate, back IN when idle. desiredCount:1 is the floor.
    const scaling = service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 6 });

    scaling.scaleOnCpuUtilization('OmniCpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnRequestCount('OmniReqScaling', {
      requestsPerTarget: 20,
      targetGroup: omniTargetGroup,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // -- Backlog-driven autoscaling (RC2-B) -----------------------------------
    // The render backlog -- NOT CPU or ALB request rate -- is the demand signal
    // that went unconsumed during program 253f20a6: the omni-backlog-metric Lambda
    // published backlog=5/running=0 for ~30 min and NOTHING acted on it. CPU/req
    // scaling above cannot see queued-but-unstarted render jobs (an idle service
    // with backlog>0 shows ~0% CPU and 0 requests), so on its own it would have
    // left the fleet at the floor exactly as observed. This binds the EXISTING
    // backlog series to a real consumer on the same scalable target.
    const omniBacklogPerTask = new cloudwatch.Metric({
      namespace: OMNI_BACKLOG_NAMESPACE,
      metricName: OMNI_BACKLOG_PER_TASK_METRIC_NAME,
      dimensionsMap: { [OMNI_BACKLOG_SERVICE_DIMENSION]: `omni-${env}` },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    scaling.scaleToTrackCustomMetric('OmniBacklogTargetTracking', {
      metric: omniBacklogPerTask,
      targetValue: OMNI_BACKLOG_PER_TASK_TARGET,
      // Short scale-OUT cooldown so capacity lands inside the FIXED 900 s W6
      // window; longer scale-IN to avoid thrash as a render drains.
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    // Fast path: any backlog above the warm baseline must add tasks immediately,
    // independent of the per-task ratio's averaging window. CHANGE_IN_CAPACITY
    // step bands keyed on the raw `backlog` count add more tasks the deeper the
    // backlog, so backlog=5/running=1 climbs toward the cap promptly inside W6.
    // Exactly one no-change band (backlog 0..2, change 0) sits between the
    // scale-in and scale-out alarms as CDK requires.
    const omniBacklog = new cloudwatch.Metric({
      namespace: OMNI_BACKLOG_NAMESPACE,
      metricName: OMNI_BACKLOG_METRIC_NAME,
      dimensionsMap: { [OMNI_BACKLOG_SERVICE_DIMENSION]: `omni-${env}` },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    scaling.scaleOnMetric('OmniBacklogStepScaling', {
      metric: omniBacklog,
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(60),
      evaluationPeriods: 1,
      // Only scale-OUT bands are declared; CDK auto-fills the implicit no-change
      // gap below `lower:3` (backlog 0..2 -> target-tracking owns that band).
      scalingSteps: [
        { lower: 3, upper: 5, change: +2 },
        { lower: 5, change: +4 },  // deep backlog -> jump toward maxCapacity.
      ],
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
