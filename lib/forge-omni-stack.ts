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
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'OmniRepo', 'omni',
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
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // -- Service auto scaling (burst tier, scale-to-zero) ----------------------
    // This fleet is the BURST tier on top of the always-warm `forge-omni` floor.
    // It scales 0 -> 3 strictly on render backlog so we never pay for idle
    // compute, and returns to 0 when the queue drains. The warm floor (1 task)
    // is provided by forge-omni, so OMNI is always reachable even at min 0 here.
    //
    // Backlog signal: workers publish OMNI/Render -> BacklogPerTask (queued jobs
    // per running task) from the shared claimable render queue (forgenew PR
    // #1649). Target 1.0 means "keep roughly one queued job per task"; a long
    // scale-in cooldown avoids thrashing mid-render, while the deregistration
    // delay + container stopTimeout let an in-flight render drain on scale-in.
    const scaling = service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: 3 });

    scaling.scaleOnMetric('OmniBacklogPerTaskScaling', {
      metric: new cloudwatch.Metric({
        namespace: 'OMNI/Render',
        metricName: 'BacklogPerTask',
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      // Step scaling from zero: any backlog brings up a task; deeper backlog
      // adds more, up to maxCapacity. Below 1 queued-job-per-task, hold/scale in.
      scalingSteps: [
        { upper: 1, change: 0 },
        { lower: 1, change: +1 },
        { lower: 3, change: +2 },
      ],
      adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(60),
      evaluationPeriods: 1,
    });

    // Reference the target group so the symbol is retained for future
    // request-based policies; backlog is the primary burst signal.
    void omniTargetGroup;

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
