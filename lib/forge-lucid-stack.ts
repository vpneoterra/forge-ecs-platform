/**
 * ForgeLucidStack -- LUCID Multi-Mode AI Workspace (Fargate)
 *
 * Deploys the LUCID backend + frontend (vpneoterra/LUCID) on the same
 * Fargate cluster and ALB used by ForgeAppStack. This replaces the
 * external Railway deployment that forge-app already points to via
 * LUCID_URL=https://api-lucid.qrucible.ai.
 *
 * Layout:
 *   - Reuses ForgeAppStack's ECS cluster, ALB, Cloud Map namespace, and
 *     ACM certificate (certificate gets a SAN for api-lucid.qrucible.ai).
 *   - One Fargate Spot task running LUCID's multi-stage image:
 *       * Python FastAPI backend on :8000 (internal)
 *       * Node frontend on :3000 (ALB target)
 *       * start.sh supervises both — matches the upstream Dockerfile.
 *   - Host-header routing on the shared ALB:
 *       api-lucid.qrucible.ai -> lucid target group (port 3000)
 *   - Cloud Map: lucid.forge.local:3000 for internal calls from forge-app.
 *   - Route 53 Alias A-record on the existing hosted zone.
 *
 * Source repo:  https://github.com/vpneoterra/LUCID
 * ECR repo:     lucid
 *
 * Cost breakdown (incremental):
 *   - Fargate Spot 512/1024 MB (always-on):     ~$6/month
 *   - Secrets Manager (6 LUCID secrets):        ~$2.40/month
 *   - CloudWatch Logs (7-day retention):        ~$0.50/month
 *   - Route 53 A-alias + ACM SAN:               free
 *   Total: ~$9/month
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ForgeLucidStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  /** Existing ECS cluster created by ForgeAppStack. */
  ecsCluster: ecs.ICluster;
  /** Existing ALB created by ForgeAppStack. */
  alb: elbv2.IApplicationLoadBalancer;
  /** HTTPS (443) listener on the shared ALB. */
  httpsListener: elbv2.IApplicationListener;
  /** Shared Cloud Map namespace (forge.local) from ForgeAppStack. */
  cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  /** Public domain for LUCID, e.g. 'api-lucid.qrucible.ai'. */
  domainName: string;
  /** Parent hosted zone, e.g. 'qrucible.ai'. */
  hostedZoneDomain: string;
  /**
   * Priority for the host-header rule on the shared HTTPS listener.
   * Must be unique across listeners. OMNI uses 10 in ForgeAppStack;
   * 20 is safely above it.
   */
  listenerRulePriority?: number;
  /**
   * Optional override for the ECR repository name (default: 'lucid').
   * Repo is expected to exist already -- created by build-images.yml.
   */
  ecrRepoName?: string;
  tags?: Record<string, string>;
}

export class ForgeLucidStack extends cdk.Stack {
  public readonly serviceName: string;
  public readonly internalEndpoint: string;
  public readonly publicUrl: string;

  constructor(scope: Construct, id: string, props: ForgeLucidStackProps) {
    super(scope, id, props);

    const priority = props.listenerRulePriority ?? 20;
    const ecrRepoName = props.ecrRepoName ?? 'lucid';

    // -- ECR repo (created out-of-band by build-images.yml) ------------------
    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'LucidRepo', ecrRepoName);

    // -- Hosted zone lookup --------------------------------------------------
    const hostedZone = route53.HostedZone.fromLookup(this, 'LucidHostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- Secrets -------------------------------------------------------------
    // LUCID-specific secrets. Supabase secrets are intentionally shared
    // with forge-app -- we import by name (no mutation) so there is no
    // collision with the ones ForgeAppStack creates under forge/test/.
    const lucidSecretNames = [
      'lucid-openai-api-key',
      'lucid-anthropic-api-key',
      'lucid-github-token',
      'lucid-github-owner',
      'lucid-github-repo',
      'lucid-forgejo-url',
      'lucid-forgejo-token',
      'lucid-forgejo-owner',
      'lucid-forgejo-repo',
      'lucid-session-secret',
    ];

    const lucidSecrets: Record<string, ecs.Secret> = {};
    for (const name of lucidSecretNames) {
      const secret = new secretsmanager.Secret(this, `Secret${name.replace(/-/g, '')}`, {
        secretName: `forge/${props.forgeEnv}/${name}`,
        description: `LUCID ${props.forgeEnv} env -- ${name}`,
      });
      const envName = name.replace(/^lucid-/, '').replace(/-/g, '_').toUpperCase();
      lucidSecrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    // Reuse the shared Supabase secrets provisioned by ForgeAppStack.
    // fromSecretNameV2 avoids the 6-char suffix requirement and does not
    // try to create or mutate the secret.
    const supabaseUrl = secretsmanager.Secret.fromSecretNameV2(
      this, 'SupabaseUrl', `forge/${props.forgeEnv}/supabase-url`,
    );
    const supabaseServiceKey = secretsmanager.Secret.fromSecretNameV2(
      this, 'SupabaseServiceKey', `forge/${props.forgeEnv}/supabase-service-key`,
    );
    const supabaseAnonKey = secretsmanager.Secret.fromSecretNameV2(
      this, 'SupabaseAnonKey', `forge/${props.forgeEnv}/supabase-anon-key`,
    );
    const supabaseJwtSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SupabaseJwtSecret', `forge/${props.forgeEnv}/supabase-jwt-secret`,
    );

    // -- CloudWatch log group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'LucidLogGroup', {
      logGroupName: `/forge/ecs/lucid-${props.forgeEnv}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -- Task roles ----------------------------------------------------------
    const executionRole = new iam.Role(this, 'LucidExecutionRole', {
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
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/${props.forgeEnv}/*`,
      ],
    }));
    ecrRepo.grantPull(executionRole);
    supabaseUrl.grantRead(executionRole);
    supabaseServiceKey.grantRead(executionRole);
    supabaseAnonKey.grantRead(executionRole);
    supabaseJwtSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, 'LucidTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Enable ECS Exec for live debugging (parity with forge-app).
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // -- Fargate task definition --------------------------------------------
    // LUCID's Dockerfile runs uvicorn (8000) + node (3000) via start.sh.
    // 512 CPU / 1024 MB is enough for the code mode; bump to 1024/2048
    // once DAC/IAC knowledge bases are loaded (-c lucidCpu / lucidMemory).
    const cpu = Number(this.node.tryGetContext('lucidCpu') ?? 512);
    const memoryLimitMiB = Number(this.node.tryGetContext('lucidMemory') ?? 1024);

    const taskDef = new ecs.FargateTaskDefinition(this, 'LucidTaskDef', {
      family: `lucid-${props.forgeEnv}`,
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const activeMode = this.node.tryGetContext('lucidActiveMode') ?? 'code';

    const container = taskDef.addContainer('lucid', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      essential: true,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        BACKEND_PORT: '8000',
        LUCID_ACTIVE_MODE: String(activeMode),
        LUCID_PUBLIC_URL: `https://${props.domainName}`,
        // Telemetry: let the dashboard stream SSE against itself.
        LUCID_TELEMETRY_ENABLED: 'true',
        LUCID_TELEMETRY_BUFFER_SIZE: '1000',
        LUCID_TELEMETRY_FLUSH_INTERVAL: '10',
        // Embed widget -- same origin as the public URL.
        LUCID_EMBED_ALLOWED_ORIGINS: 'https://forge.qrucible.ai,https://omni.qrucible.ai',
      },
      secrets: {
        // LUCID-specific
        OPENAI_API_KEY: lucidSecrets['OPENAI_API_KEY'],
        ANTHROPIC_API_KEY: lucidSecrets['ANTHROPIC_API_KEY'],
        GITHUB_TOKEN: lucidSecrets['GITHUB_TOKEN'],
        GITHUB_OWNER: lucidSecrets['GITHUB_OWNER'],
        GITHUB_REPO: lucidSecrets['GITHUB_REPO'],
        FORGEJO_URL: lucidSecrets['FORGEJO_URL'],
        FORGEJO_TOKEN: lucidSecrets['FORGEJO_TOKEN'],
        FORGEJO_OWNER: lucidSecrets['FORGEJO_OWNER'],
        FORGEJO_REPO: lucidSecrets['FORGEJO_REPO'],
        SESSION_SECRET: lucidSecrets['SESSION_SECRET'],
        // Shared Supabase (same project as forge-app)
        SUPABASE_URL: ecs.Secret.fromSecretsManager(supabaseUrl),
        SUPABASE_SERVICE_KEY: ecs.Secret.fromSecretsManager(supabaseServiceKey),
        SUPABASE_ANON_KEY: ecs.Secret.fromSecretsManager(supabaseAnonKey),
        SUPABASE_JWT_SECRET: ecs.Secret.fromSecretsManager(supabaseJwtSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'lucid',
      }),
      healthCheck: {
        // start.sh exits on first failure, so hitting the Node server is
        // enough -- if uvicorn dies, the task dies anyway.
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        // Backend cold start loads LangGraph + mode registry (~20s).
        startPeriod: cdk.Duration.seconds(90),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    // -- Fargate service (Spot, private subnet, Cloud Map) -------------------
    const service = new ecs.FargateService(this, 'LucidService', {
      cluster: props.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: `lucid-${props.forgeEnv}`,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        // Mostly Spot, one on-demand base task for availability during
        // Spot interruptions (parity with OMNI's weighting).
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },
        { capacityProvider: 'FARGATE', weight: 1, base: 1 },
      ],
      cloudMapOptions: {
        name: 'lucid',
        cloudMapNamespace: props.cloudMapNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.serviceName = service.serviceName;
    this.internalEndpoint = 'http://lucid.forge.local:3000';
    this.publicUrl = `https://${props.domainName}`;

    // -- ALB target group (host-header routing) ------------------------------
    props.httpsListener.addTargets('LucidTarget', {
      targets: [service],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.domainName]),
      ],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyHttpCodes: '200',
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // -- Route 53 alias -----------------------------------------------------
    // The ACM cert on the shared ALB must include api-lucid.qrucible.ai
    // as a SAN. That is handled in ForgeAppStack via the `lucidDomain`
    // context; see bin/forge-ecs-platform.ts.
    new route53.ARecord(this, 'LucidAlias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(props.alb as elbv2.ApplicationLoadBalancer),
      ),
      comment: 'LUCID ALB alias -- managed by CDK',
    });

    // -- Outputs ------------------------------------------------------------
    new cdk.CfnOutput(this, 'LucidPublicUrl', {
      value: this.publicUrl,
      description: 'LUCID public URL (Route 53 Alias -> shared ALB)',
    });

    new cdk.CfnOutput(this, 'LucidInternalEndpoint', {
      value: this.internalEndpoint,
      description: 'LUCID internal endpoint for forge-app via Cloud Map',
    });

    new cdk.CfnOutput(this, 'LucidEcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for LUCID images',
    });

    new cdk.CfnOutput(this, 'LucidServiceName', {
      value: service.serviceName,
      description: 'ECS service name for LUCID',
    });

    new cdk.CfnOutput(this, 'LucidActiveMode', {
      value: String(activeMode),
      description: 'Active LUCID mode (code | dac | iac)',
    });
  }
}
