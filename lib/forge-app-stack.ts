/**
 * ForgeAppStack -- FORGE Web Application + OMNI API
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and two Fargate services (forge-app + forge-omni). Host-header routing
 * on the shared ALB separates traffic:
 *   - forge.qrucible.ai  → forge-app (Node.js, port 3000)
 *   - omni.qrucible.ai   → forge-omni (PicoGK .NET, port 5000)
 *
 * Internal connectivity: forge-app reaches OMNI via Cloud Map private DNS
 * at omni.forge.local:5000 (no public internet hop).
 *
 * Route 53 integration:
 *   - ACM certificate with SAN covering both domains (auto DNS validation)
 *   - A/AAAA Alias records for both domains pointing to the ALB
 *   - No manual DNS updates ever needed -- Route 53 handles everything
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed, shared) + $0.008/LCU-hour
 *   - Fargate forge-app (256 CPU / 512 MB Spot): ~$6/month
 *   - Fargate forge-omni (8192 CPU / 16384 MB Spot): ~$72/month
 *   - Secrets Manager: $0.40/secret/month x 6 = $2.40/month
 *   - CloudWatch Logs: ~$1/month (7-day retention, 2 log groups)
 *   - Route 53 hosted zone: $0.50/month + $0.40/million queries
 *   - ACM certificate: free
 *   - Cloud Map namespace: free (first 1000 instances)
 *   Total: ~$62/month
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ForgeAppStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'forge.qrucible.ai'
  omniDomainName: string;   // e.g., 'omni.qrucible.ai'
  hostedZoneDomain: string; // e.g., 'qrucible.ai'
  deployDks?: boolean;
  /** Gemma self-hosted inference endpoint (from ForgeGemmaStack NLB) */
  gemmaEndpoint?: string;
  /** Enable Gemma routing in the forge-app task definition */
  deployGemma?: boolean;
  /**
   * Optional public domain for LUCID (e.g. 'api-lucid.qrucible.ai').
   * When provided, the shared ACM cert is issued with this hostname as
   * a SAN so the ForgeLucidStack can attach a target group to the same
   * HTTPS listener without a separate certificate.
   */
  lucidDomainName?: string;
  tags?: Record<string, string>;
}

export class ForgeAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceName: string;
  /** HTTPS listener on the shared ALB -- exposed so other stacks
   *  (e.g. ForgeLucidStack) can attach host-header target groups. */
  public readonly httpsListener: elbv2.ApplicationListener;
  /** Cloud Map namespace (forge.local) -- exposed so other stacks can
   *  register services for internal service discovery. */
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: ForgeAppStackProps) {
    super(scope, id, props);

    // -- Route 53 Hosted Zone (lookup existing) --------------------------------
    // The user has already moved qrucible.ai nameservers to Route 53.
    // We look up the existing hosted zone rather than creating a new one.
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- ECS Cluster (Fargate only -- no EC2 instances needed) ---------------
    this.ecsCluster = new ecs.Cluster(this, 'ForgeAppCluster', {
      clusterName: `forge-app-${props.forgeEnv}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false, // Save cost in dev
    });

    // -- Cloud Map Namespace (private DNS for service discovery) --------------
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ForgeNamespace', {
      name: 'forge.local',
      vpc: props.vpc,
      description: 'FORGE private service discovery',
    });
    this.cloudMapNamespace = namespace;

    // -- ECR Repository (import existing or create) --------------------------
    // Use existing repo created by the CI/CD pipeline
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'ForgeAppRepo', 'forge-app-test',
    );

    const omniEcrRepo = ecr.Repository.fromRepositoryName(
      this, 'OmniRepo', 'forge-omni',
    );

    // -- Feature flags --------------------------------------------------------
    // Runtime toggle for the autonomous pipeline (BullMQ on Redis). Disabling
    // this flag omits the redis-url secret entirely from the container env
    // so a quota-exhausted / misconfigured Redis provider cannot drive a
    // command storm from inside the task.
    //
    // Usage:
    //   cdk deploy ForgeAppStack                          # pipeline ENABLED (default)
    //   cdk deploy ForgeAppStack -c pipelineEnabled=false # pipeline DISABLED
    //
    // Server-side, forgenew/server.js treats absent or empty REDIS_URL as
    // "pipeline disabled" and serves /api/pipeline/* with 503.
    const pipelineEnabledCtx = this.node.tryGetContext('pipelineEnabled');
    const pipelineEnabled = pipelineEnabledCtx === undefined
      ? true
      : String(pipelineEnabledCtx).toLowerCase() !== 'false';

    // -- Secrets --------------------------------------------------------------
    const baseSecretNames = [
      'supabase-url',
      'supabase-service-key',
      'supabase-anon-key',
      'supabase-jwt-secret',
      'anthropic-api-key',
      'tripo-api-key',
      'together-api-key',
      'lucid-token',
      'database-url',
    ];
    // Autonomous Pipeline v2: Upstash Redis for BullMQ. Only include when
    // the pipeline is enabled, so disabling the flag is a clean CDK-only
    // change with no surviving secret reference in the task definition.
    const secretNames = pipelineEnabled
      ? [...baseSecretNames, 'redis-url']
      : baseSecretNames;

    // DKS-specific secrets (separate Supabase project: forge-dks)
    const dksSecretNames = [
      'dks-database-url',
      'dks-supabase-url',
      'dks-supabase-service-key',
    ];

    const dksSecrets: Record<string, ecs.Secret> = {};
    for (const name of dksSecretNames) {
      const secret = new secretsmanager.Secret(this, `Secret${name.replace(/-/g, '')}`, {
        secretName: `forge/test/${name}`,
        description: `DKS (forge-dks Supabase) -- ${name}`,
      });
      const envName = name.replace(/-/g, '_').toUpperCase();
      dksSecrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    const secrets: Record<string, ecs.Secret> = {};
    for (const name of secretNames) {
      const secret = new secretsmanager.Secret(this, `Secret${name.replace(/-/g, '')}`, {
        secretName: `forge/test/${name}`,
        description: `FORGE test env -- ${name}`,
      });
      const envName = name.replace(/-/g, '_').toUpperCase();
      secrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    // -- CloudWatch Log Group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'ForgeAppLogGroup', {
      logGroupName: '/forge/ecs/forge-app-test',
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
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/test/*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/forge/*`],
    }));
    // Allow pulling from ECR
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
    // Pipeline v2: Upsized from 256/512 to 512/1024 for GLB buffer processing
    // (~100-200 MB peak during ICP topology transfer + quality gate)
    const taskDef = new ecs.FargateTaskDefinition(this, 'ForgeAppTaskDef', {
      family: 'forge-app-test',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer('forge-app', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      essential: true,
      environment: {
        NODE_ENV: 'production',
        FORGE_DOMAIN: props.domainName,
        PORT: '3000',
        DEV_MODE: 'false',
        AXIOM_ENABLED: 'true',
        AXIOM_STRICT: 'false',
        // -- Maestro / Conductor orchestration --
        // Flipped to 'true' on 2026-04-22 (see .github/workflows/flip-maestro-conductor.yml
        // run 24806789117 and PR #30). Persisted here so subsequent `cdk deploy`
        // invocations do not clobber the runtime flip. Re-run the flip workflow
        // to toggle without a CDK deploy.
        MAESTRO_ENABLED: 'true',
        CONDUCTOR_ENABLED: 'true',
        // -- CHORUS --
        // Flipped to 'write' on 2026-04-23 (see .github/workflows/flip-chorus-forge-mode.yml
        // run 24844843052 and PR #35). Persisted here so subsequent `cdk deploy`
        // invocations do not clobber the runtime flip. Re-run the flip workflow
        // to toggle between write / shadow / off without a CDK deploy.
        CHORUS_FORGE_MODE: 'write',
        COMPUTE_HOST: '89.167.79.141',
        PICOGK_API_URL: 'http://89.167.79.141:8015',
        SYSML_API_URL: 'http://89.167.79.141:8003',
        HETZNER_COMPUTE_URL: 'http://89.167.79.141:8001',
        LUCID_URL: 'https://api-lucid.qrucible.ai',
        FREECAD_MCP_URL: 'http://89.167.79.141:8016',
        OMNI_API_URL: 'http://omni.forge.local:5000',
        OMNI_HOST: 'omni.forge.local',
        OMNI_PORT: '5000',
        DKS_ENABLED: 'false',
        KNOWLEDGE_SERVICE_URL: 'http://dks-query.forge.local:8020',
        // -- Gemma 4 self-hosted inference (Model Router) --
        // When GEMMA_ENABLED=false (default), all LLM calls route to Claude.
        // When GEMMA_ENABLED=true, the Model Router selects Claude vs Gemma per call.
        // Flip to 'true' AFTER the GPU instance + NLB are verified healthy.
        GEMMA_ENABLED: props.deployGemma ? 'false' : 'false', // Always deploy as disabled; flip via env update
        GEMMA_ENDPOINT: props.gemmaEndpoint || 'http://gemma-internal:8000/v1',
        GEMMA_MODEL: 'google/gemma-4-26b-a4b-it-gptq-4bit',
        GEMMA_TIMEOUT_MS: '15000',
        GEMMA_CB_THRESHOLD: '5',
        GEMMA_CB_RECOVERY_MS: '60000',
        // Hephaestus Rosetta A/B testing
        ROSETTA_ENABLED: props.deployGemma ? 'true' : 'false',
        ROSETTA_SHADOW_RATE: '0.10',
        ROSETTA_SHADOW_TIMEOUT_MS: '10000',
        // -- Geometry Platform feature flags (all OFF by default) --
        // Capability 1: B-Rep / STEP Engine
        BREP_ENGINE_ENABLED: 'false',
        BREP_ENDPOINT: 'http://forge-brep.forge-geometry.local:5090',
        // Capability 2: GPU SDF Engine (DORMANT — do not activate yet)
        GPU_SDF_ENABLED: 'false',
        GPU_SDF_ENDPOINT: 'http://forge-sdf-gpu.forge-geometry.local:5080',
        GPU_SDF_VOXEL_THRESHOLD: '1000000',
        // Capability 3: Neural SDF Engine (DORMANT — do not activate yet)
        NEURAL_SDF_ENABLED: 'false',
        NEURAL_SDF_ENDPOINT: 'http://forge-neural-sdf.forge-geometry.local:5100',
        // Capability 4: Visual ASG Editor (client-side only)
        ASG_EDITOR_ENABLED: 'false',
        // Capability 5: Field-Driven TPMS (uses existing FluxTK)
        FIELD_DRIVEN_ENABLED: 'false',
        FIELD_DRIVEN_MIN_THICKNESS_MM: '0.3',
        FIELD_DRIVEN_MAX_THICKNESS_MM: '5.0',
        // Capability 6: FluxTK / BRAIDE Network Solver
        FLUXTK_ENABLED: 'false',
        FLUXTK_API_URL: 'http://forge-fluxtk.forge-geometry.local:8040',
        // -- Autonomous Pipeline v2 configuration --
        PIPELINE_ENABLED: pipelineEnabled ? 'true' : 'false',
        PIPELINE_MAX_VARIANTS: '3',
        PIPELINE_MAX_RETRIES: '2',
        PIPELINE_BUDGET_CAP_USD: '5.00',
        PIPELINE_TRIPO_CONCURRENCY: '5',
        PIPELINE_FLUX_CONCURRENCY: '10',
      },
      secrets: {
        ...secrets,
        // DKS uses a separate Supabase project (forge-dks)
        DKS_DATABASE_URL: dksSecrets['DKS_DATABASE_URL'],
        DKS_SUPABASE_URL: dksSecrets['DKS_SUPABASE_URL'],
        DKS_SUPABASE_SERVICE_KEY: dksSecrets['DKS_SUPABASE_SERVICE_KEY'],
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'forge-app',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    // -- Monitoring sidecar -- polls internal endpoints, pushes custom metrics --
    // essential: false so a sidecar crash does not kill the main task
    taskDef.addContainer('forge-monitor-sidecar', {
      image: ecs.ContainerImage.fromRegistry('amazon/cloudwatch-agent:latest'),
      essential: false,
      environment: {
        FORGE_APP_URL: 'http://localhost:3000',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'forge-monitor',
      }),
      memoryReservationMiB: 64,
    });

    // -- ALB requires 2 AZs -- ensure we have enough public subnets -----------
    // Dev VPC may have only 1 AZ; create a second public subnet if needed.
    let albSubnets: ec2.ISubnet[] = [...props.publicSubnets];
    if (albSubnets.length < 2) {
      // Pick an AZ different from the first subnet
      const usedAz = albSubnets[0].availabilityZone;
      const allAzs = cdk.Stack.of(this).availabilityZones;
      const secondAz = allAzs.find(az => az !== usedAz) ?? allAzs[1] ?? `${this.region}b`;

      const albSubnet2 = new ec2.PublicSubnet(this, 'AlbSubnet2', {
        vpcId: props.vpc.vpcId,
        cidrBlock: '10.0.128.0/24',  // High range to avoid existing subnets
        availabilityZone: secondAz,
        mapPublicIpOnLaunch: true,
      });
      // Route internet traffic through the VPC's internet gateway
      const igwId = props.vpc.internetGatewayId!;
      albSubnet2.addDefaultInternetRoute(igwId, props.vpc.internetConnectivityEstablished);
      albSubnets.push(albSubnet2);
    }

    // -- Application Load Balancer --------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ForgeTestAlb', {
      loadBalancerName: 'forge-test-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnets: albSubnets },
      idleTimeout: cdk.Duration.seconds(600),  // I2D pipeline: 7 phases × solver steps
    });

    // -- ALB Access Logs → S3 ------------------------------------------------
    // Bucket lives here (in ForgeAppStack) because CDK's logAccessLogs() must
    // be called on the same stack that created the ALB construct. The bucket
    // name is exported so the monitoring stack and ops workflows can reference
    // it without a cross-stack circular dependency.
    const accessLogBucket = new s3.Bucket(this, 'AlbAccessLogs', {
      bucketName: `forge-alb-access-logs-${this.account}-${this.region}`,
      lifecycleRules: [{
        expiration: cdk.Duration.days(90),
      }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.alb.logAccessLogs(accessLogBucket, 'forge-app');

    // -- ACM Certificate (DNS validated via Route 53 -- fully automatic) ------
    // Single certificate covers forge.qrucible.ai, omni.qrucible.ai, and
    // optionally api-lucid.qrucible.ai (when ForgeLucidStack is deployed).
    const certSans: string[] = [props.omniDomainName];
    if (props.lucidDomainName) {
      certSans.push(props.lucidDomainName);
    }
    const certificate = new acm.Certificate(this, 'ForgeAppCert', {
      domainName: props.domainName,
      subjectAlternativeNames: certSans,
      validation: acm.CertificateValidation.fromDns(hostedZone),
      // Route 53 validation: CDK automatically creates the CNAME records
      // in the hosted zone. No manual DNS steps needed.
    });

    // HTTPS listener (primary)
    const httpsListener = this.alb.addListener('Https', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    });
    this.httpsListener = httpsListener;

    // HTTP listener -- redirect to HTTPS
    this.alb.addListener('Http', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // -- Route 53 Alias Records ------------------------------------------------
    // A records with Alias to ALB -- Route 53 automatically resolves to the
    // ALB's current IPs. No CNAME needed, no manual DNS updates ever.
    new route53.ARecord(this, 'ForgeAlbAlias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb),
      ),
      comment: 'FORGE app ALB -- managed by CDK',
    });

    // omni.qrucible.ai → same ALB (host-header routing separates traffic)
    new route53.ARecord(this, 'OmniAlbAlias', {
      zone: hostedZone,
      recordName: props.omniDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb),
      ),
      comment: 'OMNI API ALB -- managed by CDK',
    });

    // -- Fargate Service -------------------------------------------------------
    const service = new ecs.FargateService(this, 'ForgeAppService', {
      cluster: this.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: 'forge-app-test',
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false, // Private subnet, uses NAT for outbound
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
    });

    this.serviceName = 'forge-app-test';

    // Register forge-app as default target group (all traffic not matched by host rules)
    httpsListener.addTargets('ForgeAppTarget', {
      targets: [service],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
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

    // -- OMNI Service (Fargate Spot with Cloud Map) ----------------------------
    const omniLogGroup = new logs.LogGroup(this, 'OmniLogGroup', {
      logGroupName: '/forge/ecs/forge-omni',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const omniTaskDef = new ecs.FargateTaskDefinition(this, 'OmniTaskDef', {
      family: 'forge-omni',
      // Bumped 4096/8192 -> 8192/16384 after Tier 3 Run 1 OOM at 3 concurrent
      // heavy SDF renders (CylindricalVessel + HollowTube + IBeam). See
      // FORGE_OMNI_MEMORY_MEMO.md. Pairs with substrate-side concurrency cap.
      cpu: 8192,
      memoryLimitMiB: 16384,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    omniEcrRepo.grantPull(executionRole);

    const omniContainer = omniTaskDef.addContainer('omni-api', {
      image: ecs.ContainerImage.fromEcrRepository(omniEcrRepo, 'latest'),
      essential: true,
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        KNOWLEDGE_SERVICE_URL: 'http://dks-query.forge.local:8020',
      },
      secrets: {
        ANTHROPIC_API_KEY: secrets['ANTHROPIC_API_KEY'],
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: omniLogGroup,
        streamPrefix: 'omni',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:5000/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    omniContainer.addPortMappings({ containerPort: 5000 });

    const omniService = new ecs.FargateService(this, 'OmniService', {
      cluster: this.ecsCluster,
      taskDefinition: omniTaskDef,
      desiredCount: 1,
      serviceName: 'forge-omni',
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },
        { capacityProvider: 'FARGATE', weight: 1, base: 1 },
      ],
      cloudMapOptions: {
        name: 'omni',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // -- OMNI ALB target group (host-header routing: omni.qrucible.ai) --------
    httpsListener.addTargets('OmniTarget', {
      targets: [omniService],
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.omniDomainName]),
      ],
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

    // -- DKS (Design Knowledge System) -- conditional on deployDks -------------
    if (props.deployDks) {
      // ECR repos
      const dksQueryEcrRepo = ecr.Repository.fromRepositoryName(this, 'DksQueryRepo', 'dks-query');
      const dksIngestEcrRepo = ecr.Repository.fromRepositoryName(this, 'DksIngestRepo', 'dks-ingest');
      dksQueryEcrRepo.grantPull(executionRole);
      dksIngestEcrRepo.grantPull(executionRole);

      // Log groups
      const dksQueryLogGroup = new logs.LogGroup(this, 'DksQueryLogGroup', {
        logGroupName: '/forge/ecs/dks-query',
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const dksIngestLogGroup = new logs.LogGroup(this, 'DksIngestLogGroup', {
        logGroupName: '/forge/ecs/dks-ingest',
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // DKS EFS for dataset storage
      const dksEfs = new efs.FileSystem(this, 'DksEfs', {
        vpc: props.vpc,
        performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
        throughputMode: efs.ThroughputMode.BURSTING,
        encrypted: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      });

      // Allow ECS tasks to access EFS
      dksEfs.connections.allowDefaultPortFrom(props.ecsSecurityGroup);

      // Access point for DKS data
      const dksAccessPoint = dksEfs.addAccessPoint('DksDataAP', {
        path: '/dks-data',
        createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
        posixUser: { uid: '1000', gid: '1000' },
      });

      // dks-query task definition
      const dksQueryTaskDef = new ecs.FargateTaskDefinition(this, 'DksQueryTaskDef', {
        family: 'dks-query',
        cpu: 512,
        memoryLimitMiB: 1024,
        executionRole,
        taskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const dksQueryContainer = dksQueryTaskDef.addContainer('dks-query', {
        image: ecs.ContainerImage.fromEcrRepository(dksQueryEcrRepo, 'latest'),
        essential: true,
        environment: {
          LLM_BACKEND: 'claude',
          OLLAMA_HOST: 'http://ollama.forge.local:11434',
          OLLAMA_MODEL: 'gemma3:27b',
          DKS_CONFIDENCE_THRESHOLD: '0.6',
          DKS_DRY_RUN: '0',
          DKS_EMBEDDING_MODEL: 'all-MiniLM-L6-v2',
        },
        secrets: {
          DATABASE_URL: dksSecrets['DKS_DATABASE_URL'],
          DKS_SUPABASE_URL: dksSecrets['DKS_SUPABASE_URL'],
          DKS_SUPABASE_SERVICE_KEY: dksSecrets['DKS_SUPABASE_SERVICE_KEY'],
          ANTHROPIC_API_KEY: secrets['ANTHROPIC_API_KEY'],
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup: dksQueryLogGroup,
          streamPrefix: 'dks-query',
        }),
        healthCheck: {
          command: ['CMD-SHELL', 'wget -qO- http://localhost:8020/api/knowledge/stats || exit 1'],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          retries: 3,
          startPeriod: cdk.Duration.seconds(90),
        },
      });

      dksQueryContainer.addPortMappings({ containerPort: 8020 });

      // dks-query ECS service with Cloud Map
      const dksQueryService = new ecs.FargateService(this, 'DksQueryService', {
        cluster: this.ecsCluster,
        taskDefinition: dksQueryTaskDef,
        desiredCount: 0, // Start at 0 — scale up after images are pushed to ECR
        serviceName: 'dks-query',
        enableExecuteCommand: true,
        circuitBreaker: { rollback: true },
        assignPublicIp: false,
        securityGroups: [props.ecsSecurityGroup],
        vpcSubnets: { subnets: props.privateSubnets },
        capacityProviderStrategies: [
          { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
        ],
        cloudMapOptions: {
          name: 'dks-query',
          cloudMapNamespace: namespace,
          dnsRecordType: servicediscovery.DnsRecordType.A,
          dnsTtl: cdk.Duration.seconds(10),
        },
      });

      // dks-query auto-scaling
      const dksQueryScaling = dksQueryService.autoScaleTaskCount({
        minCapacity: 0, // Allow scale-to-zero until images are ready
        maxCapacity: 3,
      });

      dksQueryScaling.scaleOnCpuUtilization('DksQueryCpuScaling', {
        targetUtilizationPercent: 60,
        scaleOutCooldown: cdk.Duration.seconds(180),
        scaleInCooldown: cdk.Duration.seconds(600),
      });

      // dks-ingest task definition (standalone — no service, launched via run-task)
      const dksIngestTaskDef = new ecs.FargateTaskDefinition(this, 'DksIngestTaskDef', {
        family: 'dks-ingest',
        cpu: 4096,
        memoryLimitMiB: 8192,
        executionRole,
        taskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      // Vertex AI (Gemma) service-account JSON -- managed out-of-band in
      // Secrets Manager at forge/test/vertex-sa-json. Imported by name so CDK
      // does not try to create or mutate the secret; fromSecretNameV2 avoids
      // the 6-char suffix requirement of fromSecretCompleteArn.
      const vertexSaSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'VertexSaSecret',
        'forge/test/vertex-sa-json',
      );
      vertexSaSecret.grantRead(executionRole);

      const dksIngestContainer = dksIngestTaskDef.addContainer('dks-ingest', {
        image: ecs.ContainerImage.fromEcrRepository(dksIngestEcrRepo, 'latest'),
        essential: true,
        environment: {
          DKS_EMBEDDING_MODEL: 'all-MiniLM-L6-v2',
          // Gemma on Vertex AI (dedicated endpoint). Values mirror the
          // forge-test task definition so dks-ingest targets the same model.
          LLM_BACKEND: 'vertex',
          GEMMA_VERTEX_PROJECT: 'mindful-vial-493123-a5',
          GEMMA_VERTEX_PROJECT_NUMBER: '945884688373',
          GEMMA_VERTEX_REGION: 'us-central1',
          GEMMA_VERTEX_ENDPOINT_ID: 'mg-endpoint-8f11b5ef-4cd2-414e-a238-0f3b4904d17f',
          GEMMA_VERTEX_MODEL: 'gemma-4-26b-a4b-mg-one-click-deploy',
        },
        secrets: {
          DATABASE_URL: dksSecrets['DKS_DATABASE_URL'],
          // Full SA JSON injected at task start; vertex_backend.py reads
          // GEMMA_VERTEX_SA_KEY_JSON inline before falling back to ADC.
          GEMMA_VERTEX_SA_KEY_JSON: ecs.Secret.fromSecretsManager(vertexSaSecret),
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup: dksIngestLogGroup,
          streamPrefix: 'dks-ingest',
        }),
      });

      // EFS volume + mount for dks-ingest
      dksIngestTaskDef.addVolume({
        name: 'dks-data',
        efsVolumeConfiguration: {
          fileSystemId: dksEfs.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: dksAccessPoint.accessPointId,
            iam: 'ENABLED',
          },
        },
      });

      dksIngestContainer.addMountPoints({
        sourceVolume: 'dks-data',
        containerPath: '/data',
        readOnly: false,
      });

      // Grant EFS access to task role
      dksEfs.grantReadWrite(taskRole);

      // dks-download task definition (lightweight — for downloading datasets to EFS)
      const dksDownloadTaskDef = new ecs.FargateTaskDefinition(this, 'DksDownloadTaskDef', {
        family: 'dks-download',
        cpu: 1024,
        memoryLimitMiB: 2048,
        executionRole,
        taskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      const dlContainer = dksDownloadTaskDef.addContainer('downloader', {
        image: ecs.ContainerImage.fromRegistry('ubuntu:22.04'),
        essential: true,
        command: ['echo', 'Override command at run-task time'],
        logging: ecs.LogDrivers.awsLogs({
          logGroup: dksIngestLogGroup,
          streamPrefix: 'dks-download',
        }),
      });

      dksDownloadTaskDef.addVolume({
        name: 'dks-data',
        efsVolumeConfiguration: {
          fileSystemId: dksEfs.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: dksAccessPoint.accessPointId,
            iam: 'ENABLED',
          },
        },
      });

      dlContainer.addMountPoints({
        sourceVolume: 'dks-data',
        containerPath: '/data',
        readOnly: false,
      });

      // DKS outputs
      new cdk.CfnOutput(this, 'DksQueryServiceDiscovery', {
        value: 'dks-query.forge.local:8020',
        description: 'DKS Query internal endpoint via Cloud Map',
      });

      new cdk.CfnOutput(this, 'DksQueryLogGroupOutput', {
        value: '/forge/ecs/dks-query',
        description: 'DKS Query CloudWatch log group',
      });

      new cdk.CfnOutput(this, 'DksIngestTaskDefOutput', {
        value: dksIngestTaskDef.taskDefinitionArn,
        description: 'DKS Ingest task definition ARN (for run-task)',
      });

      new cdk.CfnOutput(this, 'DksIngestLogGroupOutput', {
        value: '/forge/ecs/dks-ingest',
        description: 'DKS Ingest CloudWatch log group',
      });

      new cdk.CfnOutput(this, 'DksEfsId', {
        value: dksEfs.fileSystemId,
        description: 'DKS EFS file system ID',
      });

      new cdk.CfnOutput(this, 'DksDownloadTaskDefArn', {
        value: dksDownloadTaskDef.taskDefinitionArn,
        description: 'DKS Download task definition ARN',
      });
    }

    // -- Outputs ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'PipelineEnabled', {
      value: pipelineEnabled ? 'true' : 'false',
      description: 'Autonomous pipeline (BullMQ/Redis) injection state. Toggle with `-c pipelineEnabled=false`.',
    });

    this.albDnsName = new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name (Route 53 Alias handles this -- no manual CNAME needed)',
      exportName: `ForgeTestAlbDns-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'ALB ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for forge-app-test images',
      exportName: `ForgeTestEcrUri-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS service name',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: `ForgeAppClusterName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'OmniServiceDiscovery', {
      value: 'omni.forge.local:5000',
      description: 'OMNI internal endpoint via Cloud Map',
    });

    new cdk.CfnOutput(this, 'OmniPublicDomain', {
      value: `https://${props.omniDomainName}`,
      description: 'OMNI public URL (Route 53 Alias → ALB, host-header routing)',
    });

    new cdk.CfnOutput(this, 'DomainSetup', {
      value: `Route 53 Alias: ${props.domainName} -> ALB (automatic, no manual DNS needed)`,
      description: 'DNS is fully managed by Route 53 + CDK',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'ACM certificate ARN (auto-validated via Route 53)',
    });

    // -- Exports for monitoring stack ----------------------------------------
    new cdk.CfnOutput(this, 'AlbFullName', {
      value: this.alb.loadBalancerFullName,
      description: 'ALB full name for CloudWatch metrics (used by ForgeMonitoringStack)',
      exportName: `ForgeTestAlbFullName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'AlbAccessLogBucketName', {
      value: accessLogBucket.bucketName,
      description: 'S3 bucket name for ALB access logs (90-day lifecycle)',
      exportName: `ForgeAlbAccessLogBucket-${props.forgeEnv}`,
    });
  }
}
