/**
 * ForgeLucidStack -- LUCID Multi-Mode AI Workspace (Fargate)
 *
 * Deploys the LUCID backend + frontend (vpneoterra/LUCID) on the same
 * Fargate cluster and ALB used by ForgeAppStack. This replaces the
 * external Railway deployment that forge-app points to via
 * LUCID_URL=https://api-lucid.qrucible.ai.
 *
 * Layout:
 *   - Reuses ForgeAppStack's ECS cluster, ALB, Cloud Map namespace, and
 *     ACM certificate (certificate gets a SAN for api-lucid.qrucible.ai).
 *   - One Fargate Spot task running LUCID's multi-stage image:
 *       * Python FastAPI backend on :8000 (internal)
 *       * Node frontend on :3000 (ALB target)
 *       * start.sh supervises both -- matches the upstream Dockerfile.
 *   - Host-header routing on the shared ALB:
 *       api-lucid.qrucible.ai -> lucid target group (port 3000)
 *   - Cloud Map: lucid.forge.local:3000 for internal calls from forge-app.
 *   - Route 53 Alias A-record on the existing hosted zone.
 *
 * Secrets layout:
 *   The stack imports existing Secrets Manager entries by bare name
 *   (fromSecretNameV2) rather than creating new ones. This matches the
 *   operator-provisioned set:
 *     LUCID_ANTHROPIC_KEY, LUCID_DEEPSEEK_KEY, LUCID_GOOGLE_KEY,
 *     LUCID_GITHUB_TOKEN, LUCID_SUPABASE_URL, LUCID_SUPABASE_ANON_KEY,
 *     LUCID_BACKEND_URL, LUCID_CORS_PROXY_URL, LUCID_STRICT_BACKEND_PROXY,
 *     LUCID_CHORUS_ENABLED, LUCID_CHORUS_SWARM_DISPATCH, FORGE_URL
 *
 * Source repo:  https://github.com/vpneoterra/LUCID
 * ECR repo:     lucid
 *
 * Cost breakdown (incremental):
 *   - Fargate Spot 512/1024 MB (always-on):     ~$6/month
 *   - Secrets Manager imports (no new secrets): $0
 *   - CloudWatch Logs (7-day retention):        ~$0.50/month
 *   - Route 53 A-alias + ACM SAN:               free
 *   Total: ~$7/month
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
import { ecsSecretByName } from './secret-lookup';

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

/**
 * Helper: import a Secrets Manager secret by exact name and return it as an
 * ecs.Secret. Delegates to secret-lookup.ts which resolves the secret's full
 * ARN (with 6-char suffix) at deploy time via AwsCustomResource. This avoids
 * the ResourceNotFoundException the ECS agent throws when valueFrom is a
 * name-only ARN.
 */
function importSecret(
  scope: Construct,
  logicalId: string,
  secretName: string,
): ecs.Secret {
  return ecsSecretByName(scope, logicalId, secretName);
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
    // All values are imported by bare name from the operator-provisioned
    // Secrets Manager entries in us-east-1. The stack never creates or
    // mutates these secrets. See file header for the full list.
    //
    // Model provider keys (required for at least one to be populated):
    const anthropicKey = importSecret(this, 'LucidAnthropicKey', 'LUCID_ANTHROPIC_KEY');
    const deepseekKey  = importSecret(this, 'LucidDeepseekKey',  'LUCID_DEEPSEEK_KEY');
    const googleKey    = importSecret(this, 'LucidGoogleKey',    'LUCID_GOOGLE_KEY');

    // GitHub integration (code mode):
    const githubToken  = importSecret(this, 'LucidGithubToken',  'LUCID_GITHUB_TOKEN');

    // Supabase (anon-key only -- server falls back to stateless reads for
    // admin ops; operator explicitly chose not to provision a service-role
    // key):
    const supabaseUrl     = importSecret(this, 'LucidSupabaseUrl',     'LUCID_SUPABASE_URL');
    const supabaseAnonKey = importSecret(this, 'LucidSupabaseAnonKey', 'LUCID_SUPABASE_ANON_KEY');

    // LUCID runtime config (stored in Secrets Manager by the operator's
    // preference -- functionally these are feature flags / URLs, but we
    // honor the chosen storage location):
    // NOTE: LUCID_BACKEND_URL is intentionally NOT imported as a Secrets
    // Manager binding because its value must be `http://localhost:8000`
    // inside the container (backend + frontend ride the same task). The
    // Secrets Manager value is kept for external callers but is applied
    // as a plain environment variable below.
    const corsProxyUrl       = importSecret(this, 'LucidCorsProxyUrl',       'LUCID_CORS_PROXY_URL');
    const strictBackendProxy = importSecret(this, 'LucidStrictBackendProxy', 'LUCID_STRICT_BACKEND_PROXY');
    const chorusEnabled      = importSecret(this, 'LucidChorusEnabled',      'LUCID_CHORUS_ENABLED');
    const chorusSwarmDispatch = importSecret(this, 'LucidChorusSwarmDispatch', 'LUCID_CHORUS_SWARM_DISPATCH');

    // FORGE integration:
    const forgeUrl = importSecret(this, 'LucidForgeUrl', 'FORGE_URL');

    // -- CloudWatch log group ------------------------------------------------
    // Import the log group by name instead of creating it. A prior failed
    // stack CREATE retained the log group (by design -- crash logs must
    // outlive a rollback), so a fresh CREATE cannot allocate the same name.
    // Importing is the idempotent path: if the group doesn't exist yet, the
    // first ECS task write creates it; retention is managed out-of-band.
    const logGroupName = `/forge/ecs/lucid-${props.forgeEnv}`;
    const logGroup = logs.LogGroup.fromLogGroupName(this, 'LucidLogGroup', logGroupName);

    // -- Task roles ----------------------------------------------------------
    const executionRole = new iam.Role(this, 'LucidExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    // Grant read on every secret we reference. fromSecretNameV2 returns an
    // ISecret whose ARN is resolved at synth-time; a coarse wildcard policy
    // avoids having to track each ARN individually while still scoping to
    // Secrets Manager in this account + region.
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
      ],
    }));
    ecrRepo.grantPull(executionRole);

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
    // 512 CPU / 1024 MB is enough for the code mode; bump via
    // -c lucidCpu / -c lucidMemory once DAC/IAC knowledge bases load.
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
        // The Python backend (uvicorn) and Node frontend run in the SAME
        // container, so the frontend must proxy to localhost, NOT to the
        // public URL (which would loop back through the ALB and deadlock
        // the healthcheck during startup).
        LUCID_BACKEND_URL: 'http://localhost:8000',
        // Telemetry: let the dashboard stream SSE against itself.
        LUCID_TELEMETRY_ENABLED: 'true',
        LUCID_TELEMETRY_BUFFER_SIZE: '1000',
        LUCID_TELEMETRY_FLUSH_INTERVAL: '10',
        // Embed widget -- same origin as the public URL.
        LUCID_EMBED_ALLOWED_ORIGINS: 'https://forge.qrucible.ai,https://omni.qrucible.ai',
      },
      secrets: {
        // Model provider keys
        ANTHROPIC_API_KEY: anthropicKey,
        DEEPSEEK_API_KEY:  deepseekKey,
        GOOGLE_API_KEY:    googleKey,
        // GitHub (code mode)
        GITHUB_TOKEN:      githubToken,
        // Supabase
        SUPABASE_URL:      supabaseUrl,
        SUPABASE_ANON_KEY: supabaseAnonKey,
        // LUCID runtime config (feature flags + URLs stored in Secrets Manager)
        // NOTE: LUCID_BACKEND_URL is intentionally set as a plain env var
        // above (http://localhost:8000) to avoid a self-referential proxy
        // loop through the public ALB. The Secrets Manager value remains
        // for external consumers but is not bound here.
        LUCID_CORS_PROXY_URL:       corsProxyUrl,
        LUCID_STRICT_BACKEND_PROXY: strictBackendProxy,
        LUCID_CHORUS_ENABLED:       chorusEnabled,
        LUCID_CHORUS_SWARM_DISPATCH: chorusSwarmDispatch,
        // FORGE integration
        FORGE_URL: forgeUrl,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'lucid',
      }),
      healthCheck: {
        // start.sh exits on first failure, so hitting the Node server is
        // enough -- if uvicorn dies, the task dies anyway.
        // curl is installed in the LUCID image (python:3.12-slim + apt-get install curl git);
        // wget is NOT — using wget here previously caused `wget: not found` → exit 127 →
        // container health check failure → ECS deployment circuit breaker → stack rollback.
        command: ['CMD-SHELL', 'curl -fsS http://localhost:3000/health || exit 1'],
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
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
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
