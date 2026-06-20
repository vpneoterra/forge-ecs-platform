/**
 * ForgeAppStack -- FORGE Web Application + OMNI API
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and two Fargate services (forge-app + forge-omni). Host-header routing
 * on the shared ALB separates traffic:
 *   - forge.qrucible.ai  → forge-app (Node.js, port 3000)
 *   - omni.qrucible.ai   → forge-omni (PicoGK .NET, port 5000)
 *
 * Internal connectivity: forge-app reaches OMNI at https://omni.qrucible.ai
 * (host-header routed to the forge-omni target on this same shared ALB). The
 * Cloud Map name omni.forge.local is NOT used for app->OMNI calls: the live
 * forge-omni service is registered only with the ALB target group, so the
 * Cloud Map `omni` record carries zero instances and omni.forge.local does
 * not resolve. OMNI_API_URL therefore points at the published ALB hostname,
 * the only OMNI endpoint that is actually reachable.
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
import { resolveEcrImage } from './image-ref';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as datasync from 'aws-cdk-lib/aws-datasync';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { importSecretByName, ecsSecretByName } from './secret-lookup';
import { CAP_PICOGK } from './config/geometry-manifest';
import { vpcSecondOctet } from './config/network-config';
import {
  OMNI_BACKLOG_NAMESPACE,
  OMNI_BACKLOG_METRIC_NAME,
  OMNI_BACKLOG_PER_TASK_METRIC_NAME,
  OMNI_BACKLOG_PER_TASK_TARGET,
  OMNI_BACKLOG_SERVICE_DIMENSION,
} from './config/omni-backlog-metric';

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
  /**
   * One-time DataSync EFS->EFS migration of the DKS dataset from the live
   * source EFS into the dev2 destination EFS. Gated (default off) and nested
   * under deployDks (the destination EFS only exists when deployDks is true).
   * The task never auto-starts; the operator runs start-task-execution.
   */
  migrateDks?: boolean;
  /** Source live EFS filesystem id (e.g. fs-...) — migrateDks input. */
  dksSrcEfsId?: string;
  /** Source EFS access point id (e.g. fsap-...) — migrateDks input. */
  dksSrcAccessPointId?: string;
  /** Source subnet id for the DataSync source ENI (same VPC/AZ as a source mount target). */
  dksSrcSubnetId?: string;
  /** Source EFS mount-target SG id — documentation only (lives in the live stack, not CDK-managed here). */
  dksSrcEfsSgId?: string;
  /** SG id for the DataSync source ENI; the operator must add 2049 ingress on dksSrcEfsSgId from it. */
  dksSrcDataSyncSgId?: string;
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
  /**
   * Whether this stack OWNS the production forge.qrucible.ai Route 53 alias.
   * Only one env may own it at a time (CloudFormation cannot CREATE a record
   * set another stack already declares). Set false on the outgoing env during a
   * blue/green cutover so the record is dropped here and CloudFormation DELETEs
   * it, freeing the name for the incoming env. Defaults true.
   */
  claimProdDomain?: boolean;
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

    // 'dev' keeps the legacy physical names that the live stack already uses;
    // any other env (e.g. 'dev2', 'prod') gets an env-suffixed name so two
    // environments can run in parallel without CloudFormation name collisions.
    const legacyEnv = props.forgeEnv === 'dev';
    const scoped = (base: string) => (legacyEnv ? base : `${base}-${props.forgeEnv}`);
    const albName = legacyEnv ? 'forge-test-alb' : `forge-${props.forgeEnv}-alb`;
    const appLogGroup = legacyEnv ? '/forge/ecs/forge-app-test' : `/forge/ecs/forge-app-${props.forgeEnv}`;
    const appServiceName = legacyEnv ? 'forge-app-test' : `forge-app-${props.forgeEnv}`;
    // Statsd metric dimensions: 'dev' keeps the legacy ClusterName/ServiceName
    // labels so the live env's Forge/ECS metric series stay continuous; other
    // envs get distinct labels so blue/green metrics don't cross-attribute.
    const metricClusterName = legacyEnv ? 'forge-app-dev' : `forge-app-${props.forgeEnv}`;
    const metricServiceName = legacyEnv ? 'forge-app-test' : `forge-app-${props.forgeEnv}`;

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

    // forge-dks sidecar (DKS runtime co-located with forge-app on :1444)
    //
    // Per-env repo naming: dev/prod have unsuffixed ECR repos (`forge-dks`),
    // dev2 has a `-dev2`-suffixed mirror (`forge-dks-dev2`) that is the only
    // one actually populated by CI in this account. The previous hard-coded
    // `forge-dks` literal caused dev2 deploys to reference a non-existent
    // repo (`forge-dks:latest` not found), triggering the ECS deployment
    // circuit breaker and rolling the entire ForgeApp-dev2 stack back --
    // which collaterally reverts the forge-omni service to its pre-update
    // task definition and undoes the KEYSTONE HF secret wiring (PR #110/#111).
    const dksRepoName = props.forgeEnv === 'dev2' ? 'forge-dks-dev2' : 'forge-dks';
    const dksEcrRepo = ecr.Repository.fromRepositoryName(
      this, 'ForgeDksRepo', dksRepoName,
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
      'rodin-api-key',
      // Live :1444 reconciliation -- secrets that were absent from CDK. Each
      // env-var name equals <name>.replace('-','_').toUpperCase(), so the loop
      // below wires them automatically (DEEP_ENDPOINT, DEEP_HF_TOKEN,
      // DEVSTRAL_HF_TOKEN, DEVSTRAL_STAGING_ENDPOINT, FORGEJO_PAT, GH_TOKEN).
      'deep-endpoint',
      'deep-hf-token',
      'devstral-hf-token',
      'devstral-staging-endpoint',
      'forgejo-pat',
      'gh-token',
      // KEYSTONE (HuggingFace provider) -- consumed by the OMNI .NET binary
      // (`docker/omni/src/Services/Keystone/ClaudeApiService.cs`). The class's
      // `IsConfigured` gate requires BOTH a non-empty `_apiKey` and a non-empty
      // `_hfBaseUrl` when `KEYSTONE_PROVIDER=huggingface` (the default). Missing
      // either short-circuits every call site:
      //   - KeystoneOrchestrator.cs:42-50  (subassembly enrichment skipped)
      //   - ClaudeApiService.GenerateSdfCandidates:202 (returns []; SdfRouter
      //     logs `KEYSTONE failed … substage=claude_empty`)
      //   - ClaudeApiService.GenerateCadQueryScript / EnrichFitAnalysis
      // The autoloader at line ~243 turns each entry below into a `secrets`
      // map key by replacing '-' with '_' and upper-casing, i.e.
      //   keystone-hf-token    -> secrets['KEYSTONE_HF_TOKEN']
      //   keystone-hf-endpoint -> secrets['KEYSTONE_HF_ENDPOINT']
      // Both are then wired into the `omni-api` container's `secrets` block
      // below. Without these the previously-good HF endpoint receives 0 calls
      // (see KEYSTONE_ZERO_CALLS_REPORT.md). Underlying secrets live at
      //   forge/test/keystone-hf-token        (hf_BNBG…JuVqETL)
      //   forge/test/keystone-hf-endpoint     (https://mfto106x86m937qp.us-east-1.aws.endpoints.huggingface.cloud)
      'keystone-hf-token',
      'keystone-hf-endpoint',
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

    // These secrets are provisioned out-of-band (CloudShell / console).
    // We resolve each secret's *full* ARN (including the 6-char suffix) at
    // deploy time via an AwsCustomResource (see secret-lookup.ts). Using
    // fromSecretNameV2 caused the rendered task definition to embed a
    // name-only ARN which the ECS agent rejected with ResourceNotFoundException
    // when it later called GetSecretValue. Using the complete ARN with suffix
    // is the form every AWS doc recommends and eliminates partial-match
    // ambiguity.
    const dksSecrets: Record<string, ecs.Secret> = {};
    for (const name of dksSecretNames) {
      const envName = name.replace(/-/g, '_').toUpperCase();
      dksSecrets[envName] = ecsSecretByName(
        this,
        `Secret${name.replace(/-/g, '')}`,
        `forge/test/${name}`,
      );
    }

    const secrets: Record<string, ecs.Secret> = {};
    for (const name of secretNames) {
      const envName = name.replace(/-/g, '_').toUpperCase();
      secrets[envName] = ecsSecretByName(
        this,
        `Secret${name.replace(/-/g, '')}`,
        `forge/test/${name}`,
      );
    }

    // Vertex SA JSON: live :1444 exposes it ONLY under the env var
    // GEMMA_VERTEX_SA_KEY_JSON (not VERTEX_SA_JSON), so it is resolved here
    // rather than via the secretNames loop, which would emit a VERTEX_SA_JSON
    // key absent from live. Wired into the forge-app container `secrets` below.
    const vertexSaForgeApp = ecsSecretByName(
      this,
      'SecretvertexsajsonForgeApp',
      'forge/test/vertex-sa-json',
    );

    // -- CloudWatch Log Group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'ForgeAppLogGroup', {
      logGroupName: appLogGroup,
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
    dksEcrRepo.grantPull(executionRole);

    // Bucket the forge-app + forge-dks containers write to at runtime. Single
    // source of truth for both the container env vars (AWS_S3_BUCKET_CEM_ASSETS,
    // DKS_RUNLOG_S3_BUCKET) and the task-role grant below. NOT env-scoped: this
    // is a shared, pre-existing CEM-assets bucket (same literal already used by
    // the live forge-app-test:1444 task def), so both BLUE and GREEN write to it.
    const cemAssetsBucket = 'forge-cem-assets';

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

    // -- S3: forge-cem-assets object writes (RC-C) ----------------------------
    // The forge-app container writes AIN/monitor snapshots (forge-dks sidecar:
    // DKS_RUNLOG_S3_BUCKET=forge-cem-assets, DKS_RUNLOG_S3_PREFIX=monitor-logs/)
    // and CEM asset objects (AWS_S3_BUCKET_CEM_ASSETS=forge-cem-assets) to this
    // bucket, but the role previously granted S3 objects only on
    // forge-platform-data-<...>/abc/* (and only inside the deployDks block), so
    // every runtime PutObject to forge-cem-assets failed AccessDenied (367x on
    // forge-cem-assets/monitor-logs/... in GREEN). This grant exists in the live
    // BLUE role out-of-band; codifying it here makes it stick on redeploy for
    // every env. Least privilege: object actions the app genuinely performs,
    // scoped to this dedicated bucket's objects only (NOT s3:* and NOT all
    // buckets). The bucket is single-purpose (CEM assets + monitor-logs), so the
    // object scope is the bucket contents rather than a per-key prefix.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CemAssetsS3ObjectReadWrite',
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:GetObject',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
      ],
      resources: [`arn:aws:s3:::${cemAssetsBucket}/*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CemAssetsS3List',
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [`arn:aws:s3:::${cemAssetsBucket}`],
    }));

    // -- S3: OMNI bridge per-part GLB writes under programs/* (FIX d560d7d6) ---
    // The OMNI enrichment bridge persists each generated GLB part to
    // s3://forge-cem-assets/programs/<programId>/<job>/<file> via the AWS SDK's
    // multipart PutObject path. On the dev2 (GREEN) cutover this failed EVERY
    // upload with AccessDenied ("not authorized to perform: s3:PutObject on
    // resource arn:aws:s3:::forge-cem-assets/programs/...") because the dev2
    // task role did not carry the forge-cem-assets write grant the live BLUE
    // role held out-of-band. The broad CemAssetsS3ObjectReadWrite statement
    // above (forge-cem-assets/*) also serves the DKS sidecar's monitor-logs/
    // prefix, so it is intentionally kept; this statement pins the EXACT
    // minimum the GLB bridge needs on the programs/* prefix as an explicit,
    // asserted contract (least privilege: only the three multipart-upload
    // object actions the SDK performs, scoped to programs/* — NOT the whole
    // bucket, NOT s3:*, NOT all buckets). Mirrors the AbcDatasetS3ReadWrite
    // explicit-PolicyStatement convention used elsewhere in this stack.
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CemAssetsProgramsGlbWrite',
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:AbortMultipartUpload',
      ],
      resources: [`arn:aws:s3:::${cemAssetsBucket}/programs/*`],
    }));

    // -- S3: OMNI render artifacts (GLB/STL) under renders/* ------------------
    // The OMNI render fleet (BomRenderWorker, running as the embedded omni-api
    // container under THIS task role) persists each rendered GLB/STL to
    // s3://forge-omni-artifacts-<account>-<region>/renders/<...>. The role
    // granted object writes only on forge-cem-assets/* and forge-platform-data-
    // <...>/abc/*; the artifacts bucket was in NO policy statement, so every
    // per-part PutObject returned AccessDenied -> OMNI produced zero GLBs ->
    // declared GeometryEmpty -> never returned a source_model_url -> the W6
    // geometry-lock predicate (with_source_model_url > 0) could never pass and
    // the whole program failed. Least privilege: only the object actions the
    // multipart-upload render path performs, scoped to the renders/* prefix (NOT
    // the whole bucket object space, NOT s3:*, NOT all buckets). Bucket name is
    // built from this.account/this.region to mirror the AbcDatasetS3ReadWrite
    // ARN-construction convention above (resolves to
    // forge-omni-artifacts-266087050444-us-east-1 in dev2).
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
    // Sized to match the live forge-app-test:1444 task def (cpu 1024 / mem
    // 3072). The prior 512/1024 was undersized for the full forge-app + DKS
    // sidecar + monitor co-location and contributed to runtime instability.
    const taskDef = new ecs.FargateTaskDefinition(this, 'ForgeAppTaskDef', {
      family: scoped('forge-app-test'),
      cpu: 1024,
      memoryLimitMiB: 3072,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Immutable image pin via CDK context (-c forgeAppImageDigest / forgeAppImageTag).
    // forge-app has its own (forgenew) build pipeline not yet wired through the
    // digest-pinning helper, so it keeps the mutable :latest fallback. This is an
    // explicit, scoped opt-out — it is NOT used for the OMNI render task defs,
    // which must always pin an immutable reference (RC2-A/RC2-C).
    const container = taskDef.addContainer('forge-app', {
      image: resolveEcrImage(this, ecrRepo, 'forgeApp', { requireImmutable: false }),
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
        // -- Conductor Phase 4 cutover (shadow -> active) --
        // Code default in server/axiom/conductor.js (`SHADOW_MODE = process.env
        // .CONDUCTOR_SHADOW_MODE !== 'false'`) resolves to TRUE whenever the
        // var is unset, so prior CDK deploys left every conductor_runs row
        // with shadow_mode=true and recrystallization phases were never
        // intercepting runMeridian. Persisted as 'false' on 2026-05-05 to
        // complete the Phase 4 cutover that was missed when CONDUCTOR_ENABLED
        // was flipped on 2026-04-22. The flip-maestro-conductor.yml workflow
        // currently does not toggle this variable; update that workflow if
        // runtime toggling without a CDK deploy is needed.
        CONDUCTOR_SHADOW_MODE: 'false',
        // -- Maestro AIN (Augmented Intent Notes / L3 capture layer) --
        // Persisted as 'true' on 2026-05-04 to fix the production
        // "ain_enabled:false" symptom observed in monitoring run
        // 2ba2596d-4ce9-4324-873e-f62db74bb6f3 (FORGE program 43b3a680).
        // Code default in lib/maestro-ain-capture.js is already on, but the
        // live forge-app-test task-def had MAESTRO_AIN_ENABLED=false set out
        // of band, so making the desired state explicit here. Use the
        // flip-maestro-ain.yml workflow to toggle without a CDK deploy.
        MAESTRO_AIN_ENABLED: 'true',
        // -- CHORUS --
        // Flipped to 'write' on 2026-04-23 (see .github/workflows/flip-chorus-forge-mode.yml
        // run 24844843052 and PR #35). Persisted here so subsequent `cdk deploy`
        // invocations do not clobber the runtime flip. Re-run the flip workflow
        // to toggle between write / shadow / off without a CDK deploy.
        CHORUS_FORGE_MODE: 'write',
        COMPUTE_HOST: 'omni.qrucible.ai',
        ...CAP_PICOGK.appEnvVars,
        // PICOGK_API_URL: live :1444 serves PicoGK off the raw compute host,
        // not the forge-geometry.local Cloud Map name from CAP_PICOGK. Override
        // the spread default to match live. (Override must follow the spread.)
        PICOGK_API_URL: 'http://89.167.79.141:8015',
        // SEL (server/sel/config/sel-config.js) reads SEL_SYSML_API_BASE_URL
        // first, falling back to SYSML_API_URL. The kernel publishes ONLY port 80
        // (nginx) via Cloud Map (forge-devops.forge.local, A-record -> nginx:80);
        // Play (:8003) and the FastAPI sidecar (:9000) are internal-only. nginx
        // routes /sysml/ -> sidecar:9000 (strips /sysml/); the sidecar's
        // /api/{path} route proxies to Play:8003 (strips /api). So a SEL raw path
        // like /branches/main/commits against this base lands on Play as
        // /branches/main/commits via the only published (:80) surface. Inert until
        // the kernel boots; transport touches on the hydrate path are swallowed.
        SEL_SYSML_API_BASE_URL: 'http://forge-devops.forge.local/sysml/api',
        SYSML_API_URL: 'http://forge-devops.forge.local/sysml/api',
        HETZNER_COMPUTE_URL: 'http://89.167.79.141:8001',
        LUCID_URL: 'https://api-lucid.qrucible.ai',
        FREECAD_MCP_URL: 'http://89.167.79.141:8016',
        // forge-app reaches OMNI via the published ALB hostname (host-header
        // routed to the forge-omni target on this same shared ALB). The prior
        // value http://omni.forge.local:5000 was an unresolvable Cloud Map name
        // — the live forge-omni service has no serviceRegistries, so the `omni`
        // Cloud Map record has zero instances and getaddrinfo ENOTFOUND was
        // returned on every /api/bomgen/health probe, failing the deploy smoke
        // test. parseOmniBase() (server/omni-cem-bridge.js) prefers OMNI_API_URL,
        // so this is the single authoritative OMNI endpoint for the bridge.
        OMNI_API_URL: 'https://omni.qrucible.ai',
        OMNI_HOST: 'omni.qrucible.ai',
        OMNI_PORT: '5000',
        DKS_ENABLED: 'true',
        KNOWLEDGE_SERVICE_URL: 'http://dks-query.forge.local:8020',
        // -- Gemma 4 self-hosted inference (Model Router) --
        // When GEMMA_ENABLED=false (default), all LLM calls route to Claude.
        // When GEMMA_ENABLED=true, the Model Router selects Claude vs Gemma per call.
        // -- Rodin BBox 3D artifact --
RODIN_BBOX_ENABLED: 'true',
FRAMES_PROGRAM_BBOX_ENABLED: 'true',
FORGE_BBOX_SEL_HYDRATE: 'true',
RODIN_MONTHLY_CREDIT_BUDGET: '1000',
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
        FLUXTK_ENABLED: 'true',
        FLUXTK_API_URL: 'http://forge-fluxtk.forge-geometry.local:8040',
        // -- Autonomous Pipeline v2 configuration --
        PIPELINE_ENABLED: pipelineEnabled ? 'true' : 'false',
        PIPELINE_MAX_VARIANTS: '3',
        PIPELINE_MAX_RETRIES: '2',
        PIPELINE_BUDGET_CAP_USD: '5.00',
        PIPELINE_TRIPO_CONCURRENCY: '5',
        PIPELINE_FLUX_CONCURRENCY: '10',
        // -- Live :1444 reconciliation (108 keys) --------------------------------
        // Every value below is copied verbatim from the live forge-app-test:1444
        // task definition (.taskdef_groundtruth/live_1444_forge-app_env.json).
        // These were absent from CDK, so cdk deploy produced a task def that
        // failed the app's [FORGE F-4] required-env gate and boot-refused.
        // -- Argus / Atlas / Axiom --
        ARGUS_ENABLED: 'true',
        ATLAS_AUDIT_ENABLED: 'true',
        AXIOM_AI_TELEMETRY_ENABLED: 'true',
        AXIOM_CEM_LOOP_VALIDATE: 'true',
        AXIOM_INTERNAL_KEY: 'axiom-forge-internal-2026',
        AXIOM_LOG_LEVEL: 'info',
        AXIOM_PREDISPATCH_CHECK: 'true',
        AXIOM_SPEC_DIMENSIONAL: 'true',
        AXIOM_TOKEN_BUDGET_DAY: '200000',
        AXIOM_USE_MOCK: 'false',
        // -- Assets / CDN / S3 --
        // CDN that fronts forge-cem-assets so a persisted GLB has a
        // public, CDN-retrievable URL (without it asset-storage.js warns the
        // stored object has no fronted public URL). No CloudFront distribution
        // is defined in this CDK repo, so this follows the same hardcoded
        // env-URL convention as LUCID_URL / QRUCIBLE_API_URL — the literal is
        // copied verbatim from the live forge-app-test:1444 task def. Applies
        // to every env (dev + dev2). NOTE: confirm this distribution actually
        // fronts forge-cem-assets for dev2 before deploy (see PR body).
        ASSET_CDN_BASE: 'https://d9va7rcq7bqjn.cloudfront.net',
        ASSET_RECONCILER_ENABLED: 'true',
        ASSET_RECONCILER_TICK_MS: '60000',
        AWS_S3_BUCKET_CEM_ASSETS: cemAssetsBucket,
        AWS_S3_REGION: 'us-east-1',
        // -- Conductor --
        CONDUCTOR_DEADLETTER_ENABLED: 'true',
        CONDUCTOR_LEASES_ENABLED: 'true',
        CONDUCTOR_VERDICTS_ENABLED: 'true',
        // -- Darwin --
        DARWIN_CIRCUIT_BREAKER_THRESHOLD: '0.05',
        DARWIN_ENABLED: 'true',
        DARWIN_HEPH_BRIDGE: 'false',
        DARWIN_JUDGE_MODEL: 'claude-sonnet-4-20250514',
        DARWIN_MAX_BRANCHES_PER_DAY: '3',
        DARWIN_MIN_SAMPLE_SIZE: '10',
        DARWIN_RESEARCHER_MODEL: 'claude-sonnet-4-20250514',
        // -- Deep / Devstral / DKS --
        DEEP_ENABLED: 'true',
        DEVSTRAL_ENABLED: 'true',
        DKS_SERVICE_URL: 'http://localhost:8020',
        // -- Forgejo / Forge core --
        FORGEJO_URL: 'http://forge-devops.forge.local/git',
        FORGE_ADMIT_COST_BUDGET_USD_PER_MIN: '5.0',
        FORGE_ADMIT_MAX: '16',
        FORGE_ADMIT_SLOW_LANE_MS: '60000',
        FORGE_ARCHETYPE_BINDER: 'true',
        FORGE_AUTO_CLASP_ON_DECOMPOSE: 'true',
        FORGE_AUTO_EMIT_BOM_READY: 'true',
        FORGE_AUTO_EMIT_PROGRAM_READY: 'true',
        FORGE_AUTO_W3_ON_SP_ACTIVATED: 'true',
        FORGE_AUTO_W4_ON_SP_ACTIVATED: 'true',
        FORGE_AUTO_W5_ON_SP_ACTIVATED: 'true',
        FORGE_BRIEF_PREFLIGHT_STRICT: 'false',
        FORGE_COMPOSE_QUALITY_ENABLED: 'true',
        FORGE_DEEP_ENRICHMENT: 'true',
        FORGE_DEEP_SPATIAL_ASSEMBLY: 'true',
        FORGE_DEFAULT_NEXUS_LOOP_MODE: 'write',
        FORGE_DEFAULT_PROGRAM_LOOP_MODE: 'write',
        FORGE_DYNAMIC_ADMIT: 'true',
        FORGE_FEATURE_FLAG_STORE_URL: '',
        FORGE_GENERATION_STAGE_MACHINE: 'true',
        FORGE_GIT_BASE_BRANCH: 'hephaestus',
        FORGE_HONEST_BANNERS: 'true',
        FORGE_LAZY_START_ALL_EVENTS: 'true',
        FORGE_LEGACY_SP_ACTIVATED_BOMGEN: 'false',
        FORGE_NEXUS_LOOP_GLOBAL_DISABLE: 'false',
        FORGE_SWEEP_AUTO_DRIVE: 'true',
        FRAMES_EMIT_ENABLED: 'true',
        // -- Gemma / Vertex --
        GEMMA_PROVIDER: 'vertex',
        GEMMA_VERTEX_CB_RECOVERY_MS: '60000',
        GEMMA_VERTEX_CB_THRESHOLD: '5',
        GEMMA_VERTEX_ENDPOINT_ID: 'mg-endpoint-8f11b5ef-4cd2-414e-a238-0f3b4904d17f',
        GEMMA_VERTEX_MODE: 'openai_shim',
        GEMMA_VERTEX_MODEL: 'gemma-4-26b-a4b-mg-one-click-deploy',
        GEMMA_VERTEX_PROJECT: 'mindful-vial-493123-a5',
        GEMMA_VERTEX_PROJECT_NUMBER: '945884688373',
        GEMMA_VERTEX_REGION: 'us-central1',
        GEMMA_VERTEX_TIMEOUT_MS: '20000',
        // -- GitHub --
        GITHUB_OWNER: 'vpneoterra',
        GITHUB_REPO: 'forgenew',
        // -- Hydrate diagnostics --
        HYDRATE_DIAG_EFFORT: 'medium',
        HYDRATE_DIAG_MAX_RETRIES: '0',
        HYDRATE_DIAG_TIMEOUT_MS: '180000',
        // -- Image / diag --
        IMAGE_TAG: '8a9a4078705e0a692a58aa12b560c8c6a0eef4a1',
        INTERNAL_DIAG_TOKEN: '1234',
        // KEYSTONE_HF_ENDPOINT was previously hard-coded here as an env literal,
        // but it is now sourced from the `forge/test/keystone-hf-endpoint` secret
        // (see baseSecretNames -> `keystone-hf-endpoint` and the omni-api +
        // forge-app `secrets` blocks below). ECS rejects task definitions that
        // declare the same key as both `environment` and `secrets` on a single
        // container, so keeping the literal here causes:
        //   `The secret name must be unique and not shared with any new or
        //    existing environment variables set on the container, such as
        //    'KEYSTONE_HF_ENDPOINT'.`
        // The runtime value is identical (same URL string lives inside the
        // secret), so removing the literal is a no-op for the application.
        // -- Maestro --
        MAESTRO_BACKEND: 'pgboss',
        MAESTRO_HARNESS_ENABLED: 'true',
        MAESTRO_HARNESS_MONITOR_ONLY: 'false',
        MAESTRO_PERIODIC_SWEEP_ENABLED: 'true',
        MAESTRO_RETRY_FAILED_SP: 'false',
        MAESTRO_SAGA_BACKEND_GPU_LEASE_ENABLED: 'false',
        MAESTRO_SAGA_BACKEND_IR_REVERT_ENABLED: 'false',
        MAESTRO_SAGA_BACKEND_MESH_BLOB_ENABLED: 'false',
        MAESTRO_SAGA_BACKEND_SOLVER_KILL_ENABLED: 'false',
        MAESTRO_SERVER_DRIVERS_ENABLED: 'true',
        MAESTRO_STALE_ACTIVE_MS: '600000',
        MAESTRO_SWEEP_MS: '30000',
        MAESTRO_SYSTEM_USER_ID: '83480f67-e6f2-4876-9abc-d32e5471fd4a',
        MAESTRO_V2_HEARTBEATS_ENABLED: 'true',
        // -- MCP --
        MCP_APPS_ENABLED: 'true',
        MCP_ELICIT_ENABLED: 'false',
        MCP_ELICIT_TIMEOUT_MS: '300000',
        MCP_GATEWAY_ENABLED: 'true',
        MCP_REGIONS_TEMPLATE_DIR: 'concertmaster/catalog/region_templates',
        MCP_SERVER_ENABLED: 'true',
        MCP_SSE_VIEW_STATE_ENABLED: 'false',
        MCP_SUPABASE_SERVICE_ROLE_KEY: '',
        MCP_UNIFIED_WORKFLOW_ENABLED: 'true',
        // -- Meridian / Nexus / Omni / Pantheon --
        MERIDIAN_PHASE_TIMEOUT_MS: '300000',
        NEXUS_SCHEDULER_CONCURRENCY: '2',
        NEXUS_SCHEDULER_ENABLED: 'true',
        NEXUS_SCHEDULER_POLL_MS: '2000',
        OMNI_FIDELITY_GATE_ENFORCE: 'true',
        PANTHEON_MAX_ROUNDS: '1',
        // -- Qrucible --
        QRUCIBLE_API_URL: 'https://ip.qrucible.ai',
        QRUCIBLE_BACKEND_URL: 'https://ip.qrucible.ai',
        // -- UI engine phases --
        UI_ENG_PHASE_1_ENABLED: 'true',
        UI_ENG_PHASE_2_ENABLED: 'true',
        UI_ENG_PHASE_3_ENABLED: 'true',
        UI_ENG_PHASE_4_ENABLED: 'true',
      },
      secrets: {
        ...secrets,
        // DKS uses a separate Supabase project (forge-dks)
        DKS_DATABASE_URL: dksSecrets['DKS_DATABASE_URL'],
        DKS_SUPABASE_URL: dksSecrets['DKS_SUPABASE_URL'],
        DKS_SUPABASE_SERVICE_KEY: dksSecrets['DKS_SUPABASE_SERVICE_KEY'],
        // Live :1444 secrets whose env-var name differs from the secret short
        // name. Reuse the already-resolved ecs.Secret objects so no duplicate
        // AwsCustomResource lookup is created for the same underlying secret.
        GEMMA_VERTEX_SA_KEY_JSON: vertexSaForgeApp, // forge/test/vertex-sa-json
        FORGEJO_TOKEN: secrets['FORGEJO_PAT'],               // same secret as FORGEJO_PAT
        SUPABASE_SERVICE_ROLE_KEY: secrets['SUPABASE_SERVICE_KEY'], // same as SUPABASE_SERVICE_KEY
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

    // -- forge-dks sidecar -- DKS runtime co-located with forge-app -----------
    // Present in the live forge-app-test:1444 task def but entirely absent from
    // CDK, so cdk deploy dropped it. essential:false so a DKS crash does not
    // kill the main task. Env + secrets copied verbatim from
    // .taskdef_groundtruth/live_1444_dks_full.json. The two secrets reuse the
    // already-resolved ecs.Secret objects (dks-database-url, anthropic-api-key)
    // to avoid duplicate AwsCustomResource lookups.
    // Immutable image pin via CDK context (-c forgeDksImageDigest / forgeDksImageTag).
    // Scoped :latest opt-out (own pipeline, not OMNI) — see forge-app note above.
    taskDef.addContainer('forge-dks', {
      image: resolveEcrImage(this, dksEcrRepo, 'forgeDks', { requireImmutable: false }),
      essential: false,
      environment: {
        DKS_RUNLOG_S3_PREFIX: 'monitor-logs/',
        DKS_LOG_LEVEL: 'INFO',
        DKS_RUNLOG_ENABLED: '1',
        AWS_REGION: 'us-east-1',
        DKS_RUNLOG_S3_BUCKET: cemAssetsBucket,
        DKS_CONFIDENCE_THRESHOLD: '0.6',
      },
      secrets: {
        DATABASE_URL: dksSecrets['DKS_DATABASE_URL'], // forge/test/dks-database-url
        ANTHROPIC_API_KEY: secrets['ANTHROPIC_API_KEY'],
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'forge-dks',
      }),
      healthCheck: {
        // Live command has a nested-unescaped-quote bug; use the correctly
        // escaped urllib equivalent (same intent: probe localhost:8020/ready).
        command: [
          'CMD-SHELL',
          'python3 -c "import urllib.request; urllib.request.urlopen(\'http://localhost:8020/ready\')" || exit 1',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    // -- Monitoring sidecar -- polls internal endpoints, pushes custom metrics --
    // essential: false so a sidecar crash does not kill the main task
    taskDef.addContainer('forge-monitor-sidecar', {
      image: ecs.ContainerImage.fromRegistry('amazon/cloudwatch-agent:latest'),
      essential: false,
      environment: {
        // CW_CONFIG_CONTENT drives the CloudWatch agent to actually emit
        // metrics (statsd -> Forge/ECS namespace). Copied verbatim from the
        // live forge-app-test:1444 task def
        // (.taskdef_groundtruth/live_1444_monitor.json). The prior FORGE_APP_URL
        // stub did nothing -- the agent had no config and emitted no metrics.
        CW_CONFIG_CONTENT:
          `{"agent": {"metrics_collection_interval": 60, "omit_hostname": true, "debug": false}, "metrics": {"namespace": "Forge/ECS", "append_dimensions": {"ClusterName": "${metricClusterName}", "ServiceName": "${metricServiceName}"}, "metrics_collected": {"statsd": {"service_address": ":8125", "metrics_collection_interval": 60, "metrics_aggregation_interval": 60}}}}`,
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
        cidrBlock: `10.${vpcSecondOctet(props.forgeEnv)}.128.0/24`,  // High range to avoid existing subnets
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
      loadBalancerName: albName,
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
      bucketName: scoped(`forge-alb-access-logs-${this.account}-${this.region}`),
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
    // Both the forge and omni prod aliases point at THIS shared app ALB: forge
    // hits the default target group, omni is routed by the OmniTarget
    // host-header listener rule below. Gated on claimProdDomain so exactly one
    // env owns the prod names: during a blue/green cutover the outgoing env
    // deploys with claimProdDomain=false, dropping both records so
    // CloudFormation DELETEs them and frees the names for the incoming env.
    if (props.claimProdDomain ?? true) {
      new route53.ARecord(this, 'ForgeAlbAlias', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(this.alb),
        ),
        comment: 'FORGE app ALB -- managed by CDK',
      });

      // omni.qrucible.ai resolves to the SAME app ALB; the OmniTarget
      // host-header rule (priority 10) forwards it to the embedded omni
      // service. Distinct logical id from ForgeOmniStack's standalone
      // 'OmniAlbAlias' so the two never collide.
      new route53.ARecord(this, 'OmniAppAlbAlias', {
        zone: hostedZone,
        recordName: props.omniDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(this.alb),
        ),
        comment: 'OMNI via FORGE app ALB host-header -- managed by CDK',
      });
    }

    // -- Fargate Service -------------------------------------------------------
    const service = new ecs.FargateService(this, 'ForgeAppService', {
      cluster: this.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: appServiceName,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false, // Private subnet, uses NAT for outbound
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
      // Cloud Map registration for forge-app-test is managed OUT-OF-BAND
      // (srv-oxqi6vvrhy44u2jr, created 2026-05-28 per
      // FluxTK_ServiceDiscovery_RCA.md / PR #58). A CDK-managed cloudMapOptions
      // here collides with that pre-existing service ('already exists') and
      // deadlocks deploy, so it is intentionally omitted. See drift
      // reconciliation Option B.
    });

    this.serviceName = appServiceName;

    // Register forge-app as default target group (all traffic not matched by host rules)
    httpsListener.addTargets('ForgeAppTarget', {
      targets: [service],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/health',
        // [GREEN-DEPLOY-503 2026-06-07] Tightened from interval=30s/timeout=10s.
        // Root cause of the deploy-time 503 windows: at desiredCount=1, a new
        // task needed 2 consecutive passes 30s apart (~60s) to register, while
        // the old target drained in ~30s (deregistrationDelay) — leaving the
        // target group with ZERO healthy targets for ~30s on every rolling
        // deploy, so the ALB returned 503. With interval=15s a new task goes
        // healthy in ~30s (2 x 15s), inside the drain window, closing the gap.
        // timeout must stay < interval; 5s is ample for the trivial /health.
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyHttpCodes: '200',
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // -- OMNI Service (Fargate Spot with Cloud Map) ----------------------------
    const omniLogGroup = new logs.LogGroup(this, 'OmniLogGroup', {
      logGroupName: scoped('/forge/ecs/forge-omni'),
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const omniTaskDef = new ecs.FargateTaskDefinition(this, 'OmniTaskDef', {
      family: scoped('forge-omni'),
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

    // Immutable image pin via CDK context (-c forgeOmniImageDigest / forgeOmniImageTag).
    const omniContainer = omniTaskDef.addContainer('omni-api', {
      image: resolveEcrImage(this, omniEcrRepo, 'forgeOmni'),
      essential: true,
      // [RC#2 4270137b 2026-06-19] Container-level hard memory limit (GREEN/-dev2
      // deployed taskdef — this embedded omni-api is the one running as
      // forge-omni-dev2:151, which the analysis found with memory=null). Without
      // it, an unbounded SdfShapeRouter placeholder mesh OOM-killed the whole
      // TASK before any terminal render callback (exit 137,
      // omni_task_died_before_terminal). The explicit limit scopes the OOM to the
      // container (clean restart) and gives the SdfRouter vertex-ceiling a real
      // byte budget. Set just under the task limit (16384) for sidecar headroom;
      // omni-api is the only essential container.
      memoryLimitMiB: 15360,
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        KNOWLEDGE_SERVICE_URL: 'http://dks-query.forge.local:8020',
        // FluxTK conservation solver discovery. Cloud Map FQDN required because
        // forge-fluxtk lives in `forge-geometry.local` namespace while OMNI lives
        // in `forge.local` -- bare label `forge-fluxtk` would NXDOMAIN against the
        // VPC DHCP search-domain `ec2.internal`. ASP.NET maps `FluxTK__BaseUrl`
        // (double-underscore) -> configuration key `FluxTK:BaseUrl`.
        // RCA: FluxTK_ServiceDiscovery_RCA.md (2026-05-28).
        FluxTK__BaseUrl: 'http://forge-fluxtk.forge-geometry.local:8040',
        // FORGE Node enrichment bridge (server/omni-enrichment-bridge.js) mounted
        // at /api/omni-enriched in server.js. Was defaulting to localhost:3000
        // which (a) doesn't exist in the OMNI task and (b) had a wrong path prefix.
        // Derived from the SAME constructs that name + register the forge-app
        // service in this stack: the env-scoped service name (appServiceName,
        // 'forge-app-test' on legacy dev / 'forge-app-<env>' otherwise) and the
        // Cloud Map namespace this stack creates (namespace.namespaceName,
        // 'forge.local'). The prior hardcoded 'forge-app-test' was the BLUE/dev
        // name and does not resolve from the GREEN (dev2) network, where the
        // app registers as forge-app-dev2.forge.local.
        ENRICHMENT_BRIDGE_URL:
          `http://${appServiceName}.${namespace.namespaceName}:3000/api/omni-enriched`,
        // KEYSTONE provider selection. `ClaudeApiService` defaults to
        // 'huggingface' when this env var is unset, but we set it explicitly so
        // the live task-definition reflects the intended provider and so a
        // future rollback to 'anthropic' is a one-line CDK edit + redeploy
        // (rather than a code change). KEYSTONE must use the HuggingFace path,
        // not Claude. ANTHROPIC_API_KEY is retained below only as a documented
        // rollback path; with KEYSTONE_PROVIDER=huggingface it is never read.
        KEYSTONE_PROVIDER: 'huggingface',
      },
      secrets: {
        ANTHROPIC_API_KEY: secrets['ANTHROPIC_API_KEY'],
        // KEYSTONE HuggingFace provider configuration. Both are required for
        // ClaudeApiService.IsConfigured == true (see comment in secretNames
        // above). The hardcoded fallback endpoint URL inside the .NET binary
        // is intentionally the SAME host as the secret value -- the secret
        // exists so it can be rotated (or pointed at a different endpoint)
        // without rebuilding the container image.
        KEYSTONE_HF_TOKEN: secrets['KEYSTONE_HF_TOKEN'],
        KEYSTONE_HF_ENDPOINT: secrets['KEYSTONE_HF_ENDPOINT'],
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

    // -- OMNI demand-driven autoscaling (RC2-B) -------------------------------
    // RC2-B: the `omni-backlog-metric` Lambda correctly published backlog=5,
    // running=0 for ~30 min during program 253f20a6, but NOTHING consumed it --
    // the only scalers were fixed-cron (offhours/blue/green window), none keyed
    // on backlog, none invoked in the program window. The render tier had zero
    // demand elasticity. This wires the EXISTING backlog series to an actual
    // consumer: a scalable target + a step-scaling policy that adds capacity the
    // moment backlog>0 and running<backlog, fast enough to land RUNNING capacity
    // inside the fixed 900 s W6 window.
    //
    // forge-omni is the single sustaining render worker (RC2-F): it ran
    // desiredCount=1 with no scaling, so it could hold at most one render. Giving
    // it a backlog-aware scalable target with a non-zero warm baseline (MinCapacity)
    // and a short scale-out cooldown is the infra half of RC2-F that lives in this
    // repo (the lease-heartbeat half lives in forgenew).
    const omniScalableTarget = omniService.autoScaleTaskCount({
      minCapacity: 1,   // warm baseline -- never zero; a queued program always has a worker.
      maxCapacity: 6,   // covers the 5-concurrent-job peak observed in Solar Nomad + headroom.
    });

    // backlog_per_task series from the existing omni-backlog-metric Lambda,
    // dimensioned to THIS service. Target-tracking drives DesiredCount toward
    // backlog whenever running<backlog, then scales back in as it drains.
    const omniBacklogPerTask = new cloudwatch.Metric({
      namespace: OMNI_BACKLOG_NAMESPACE,
      metricName: OMNI_BACKLOG_PER_TASK_METRIC_NAME,
      dimensionsMap: { [OMNI_BACKLOG_SERVICE_DIMENSION]: 'forge-omni' },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    omniScalableTarget.scaleToTrackCustomMetric('OmniBacklogTargetTracking', {
      metric: omniBacklogPerTask,
      targetValue: OMNI_BACKLOG_PER_TASK_TARGET,
      // Short scale-OUT cooldown so capacity arrives well inside the 900 s W6
      // window (the W6 timeout is FIXED and must not be extended). Longer
      // scale-IN cooldown to avoid thrashing as a render drains.
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    // Step-scaling fast path on the raw `backlog` count: any backlog above the
    // warm baseline must add tasks immediately, independent of the per-task
    // ratio's averaging window. CHANGE_IN_CAPACITY bands add more tasks the
    // deeper the backlog so capacity lands inside the FIXED 900 s W6 window.
    // Exactly one no-change band (backlog 0..2) sits between the scale-in and
    // scale-out alarms as CDK requires.
    const omniBacklog = new cloudwatch.Metric({
      namespace: OMNI_BACKLOG_NAMESPACE,
      metricName: OMNI_BACKLOG_METRIC_NAME,
      dimensionsMap: { [OMNI_BACKLOG_SERVICE_DIMENSION]: 'forge-omni' },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    });

    omniScalableTarget.scaleOnMetric('OmniBacklogStepScaling', {
      metric: omniBacklog,
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(60),
      evaluationPeriods: 1,
      // Only scale-OUT bands are declared; CDK auto-fills the implicit no-change
      // gap below `lower:3` (backlog 0..2 -> target-tracking owns that band).
      scalingSteps: [
        { lower: 3, upper: 5, change: +2 },
        { lower: 5, change: +4 },  // deep backlog -> jump toward MaxCapacity.
      ],
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
        logGroupName: scoped('/forge/ecs/dks-query'),
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const dksIngestLogGroup = new logs.LogGroup(this, 'DksIngestLogGroup', {
        logGroupName: scoped('/forge/ecs/dks-ingest'),
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

      // ── One-time DataSync EFS→EFS migration (gated, never auto-starts) ───────
      // Copies the live DKS dataset from the source EFS (live env) into this
      // env's fresh destination EFS (dksEfs). Defined only when migrateDks=true;
      // a normal deploy produces zero DataSync resources. Nested under deployDks
      // because the destination location needs dksEfs / dksAccessPoint.
      if (props.migrateDks) {
        if (!props.dksSrcEfsId || !props.dksSrcAccessPointId || !props.dksSrcSubnetId) {
          throw new Error(
            'migrateDks=true requires context inputs dksSrcEfsId, dksSrcAccessPointId, ' +
              'and dksSrcSubnetId (the live source EFS, its access point, and a subnet ' +
              'in the source EFS VPC/AZ for the DataSync source ENI).',
          );
        }

        const account = cdk.Stack.of(this).account;
        const region = cdk.Stack.of(this).region;

        // Dedicated SG for the DataSync ENIs (destination side). The dev2 EFS
        // already allows its default port from props.ecsSecurityGroup; we grant
        // this dedicated SG explicit 2049 ingress so the migration ENI is not
        // overloaded onto the ECS task SG identity.
        const dataSyncSg = new ec2.SecurityGroup(this, 'DksMigrateDataSyncSg', {
          vpc: props.vpc,
          description: 'DataSync ENIs for the one-time DKS EFS->EFS migration',
          allowAllOutbound: true,
        });
        dksEfs.connections.allowDefaultPortFrom(dataSyncSg, 'DataSync migration ENI -> dev2 DKS EFS');

        const sgArn = (sgId: string) =>
          `arn:aws:ec2:${region}:${account}:security-group/${sgId}`;
        const subnetArn = (subnetId: string) =>
          `arn:aws:ec2:${region}:${account}:subnet/${subnetId}`;

        // a. Destination location — the dev2 dksEfs, mounted via its access point
        //    (AP forces posix 1000/1000 and /dks-data root, preserved automatically).
        const dstLocation = new datasync.CfnLocationEFS(this, 'DksMigrateDstLocation', {
          efsFilesystemArn: dksEfs.fileSystemArn,
          accessPointArn: dksAccessPoint.accessPointArn,
          inTransitEncryption: 'TLS1_2',
          ec2Config: {
            securityGroupArns: [sgArn(dataSyncSg.securityGroupId)],
            subnetArn: subnetArn(props.privateSubnets[0].subnetId),
          },
        });

        // b. Source location — the LIVE source EFS, built from context inputs.
        //    The source EFS ARN/AP ARN are derived from the passed ids, not hardcoded.
        //    MANUAL PREREQUISITE (operator, before start-task-execution): the source
        //    mount-target SG (props.dksSrcEfsSgId, e.g. sg-0121eeb2e30a5a3c4) lives in
        //    the live dev stack and is NOT CDK-managed here, so it cannot be mutated
        //    from this stack. Add a 2049 (NFS) ingress rule on it FROM the DataSync
        //    source ENI SG (props.dksSrcDataSyncSgId) so the source ENI can mount.
        const srcDataSyncSgArns = props.dksSrcDataSyncSgId
          ? [sgArn(props.dksSrcDataSyncSgId)]
          : [sgArn(dataSyncSg.securityGroupId)];
        const srcEfsArn = `arn:aws:elasticfilesystem:${region}:${account}:file-system/${props.dksSrcEfsId}`;
        const srcApArn = `arn:aws:elasticfilesystem:${region}:${account}:access-point/${props.dksSrcAccessPointId}`;
        const srcLocation = new datasync.CfnLocationEFS(this, 'DksMigrateSrcLocation', {
          efsFilesystemArn: srcEfsArn,
          accessPointArn: srcApArn,
          inTransitEncryption: 'TLS1_2',
          ec2Config: {
            securityGroupArns: srcDataSyncSgArns,
            subnetArn: subnetArn(props.dksSrcSubnetId),
          },
        });

        // CloudWatch log group + resource policy so DataSync can write task logs.
        const dksMigrateLogGroup = new logs.LogGroup(this, 'DksMigrateLogGroup', {
          logGroupName: `/aws/datasync/dks-migrate-${props.forgeEnv}`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // DataSync writes to CloudWatch Logs via a log-group resource policy
        // (the service principal must be granted PutLogEvents on the group).
        new logs.CfnResourcePolicy(this, 'DksMigrateLogPolicy', {
          policyName: `dks-migrate-datasync-${props.forgeEnv}`,
          policyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'DataSyncLogsToCloudWatch',
                Effect: 'Allow',
                Principal: { Service: 'datasync.amazonaws.com' },
                Action: ['logs:PutLogEvents', 'logs:CreateLogStream'],
                Resource: `${dksMigrateLogGroup.logGroupArn}:*`,
              },
            ],
          }),
        });

        // c. The migration task. Does NOT auto-start.
        const dksMigrateTask = new datasync.CfnTask(this, 'DksMigrateTask', {
          name: `dks-migrate-${props.forgeEnv}`,
          sourceLocationArn: srcLocation.ref,
          destinationLocationArn: dstLocation.ref,
          cloudWatchLogGroupArn: dksMigrateLogGroup.logGroupArn,
          options: {
            verifyMode: 'POINT_IN_TIME_CONSISTENT',
            overwriteMode: 'ALWAYS',
            preserveDeletedFiles: 'PRESERVE',
            posixPermissions: 'PRESERVE',
            transferMode: 'CHANGED',
            logLevel: 'TRANSFER',
          },
        });

        new cdk.CfnOutput(this, 'DksMigrateTaskArn', {
          value: dksMigrateTask.ref,
          description: 'DataSync task ARN — operator runs `aws datasync start-task-execution` against this.',
        });
        new cdk.CfnOutput(this, 'DksMigrateSrcLocationArn', {
          value: srcLocation.ref,
          description: 'DataSync source EFS location ARN (live source).',
        });
        new cdk.CfnOutput(this, 'DksMigrateDstLocationArn', {
          value: dstLocation.ref,
          description: 'DataSync destination EFS location ARN (this env dksEfs).',
        });
      }

      // dks-query task definition
      const dksQueryTaskDef = new ecs.FargateTaskDefinition(this, 'DksQueryTaskDef', {
        family: scoped('dks-query'),
        cpu: 512,
        memoryLimitMiB: 1024,
        executionRole,
        taskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      // Immutable image pin via CDK context (-c dksQueryImageDigest / dksQueryImageTag).
      // Scoped :latest opt-out (own pipeline, not OMNI) — see forge-app note above.
      const dksQueryContainer = dksQueryTaskDef.addContainer('dks-query', {
        image: resolveEcrImage(this, dksQueryEcrRepo, 'dksQuery', { requireImmutable: false }),
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
          // The dks-query image ships python3 but NOT wget/curl. The previous
          // `wget -qO- ...` command exited 127 (command not found) on every
          // probe, so the container was permanently marked UNHEALTHY and ECS
          // killed each task before it could register in Cloud Map -- the
          // service never had a healthy instance. This was latent because the
          // service ran at desiredCount:0. Verified in-container:
          // /api/knowledge/stats returns HTTP 200 immediately; there is no
          // /ready endpoint on this image. Use python3+urllib (the only HTTP
          // client present), matching the working forge-dks sidecar's probe.
          command: [
            'CMD-SHELL',
            "python3 -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8020/api/knowledge/stats', timeout=5).status == 200 else 1)\" || exit 1",
          ],
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
        // Run one task so the service registers an A record in Cloud Map.
        // forge-omni + forge-app consume KNOWLEDGE_SERVICE_URL=
        // http://dks-query.forge.local:8020; with desiredCount:0 the Cloud Map
        // service had zero registered instances, so dks-query.forge.local did
        // not resolve and OMNI's KnowledgeClient failed with SocketException
        // "Name or service not known" on every /api/knowledge/bond-precedent
        // call. The dks-query:latest image is present in ECR, so the original
        // "start at 0 until images are pushed" rationale no longer applies.
        desiredCount: 1,
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
        // Keep at least one task registered in Cloud Map at all times so
        // dks-query.forge.local always resolves for OMNI's KnowledgeClient.
        // Scale-to-zero is what produced the empty A record / DNS failure.
        minCapacity: 1,
        maxCapacity: 3,
      });

      dksQueryScaling.scaleOnCpuUtilization('DksQueryCpuScaling', {
        targetUtilizationPercent: 60,
        scaleOutCooldown: cdk.Duration.seconds(180),
        scaleInCooldown: cdk.Duration.seconds(600),
      });

      // dks-ingest task definition (standalone — no service, launched via run-task)
      const dksIngestTaskDef = new ecs.FargateTaskDefinition(this, 'DksIngestTaskDef', {
        family: scoped('dks-ingest'),
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
      // Secrets Manager at forge/test/vertex-sa-json. Imported at deploy time
      // with its full ARN (including suffix) via importSecretByName so the
      // ECS agent can successfully call GetSecretValue at container start.
      const vertexSaSecret = importSecretByName(
        this,
        'VertexSaSecret',
        'forge/test/vertex-sa-json',
      );
      vertexSaSecret.grantRead(executionRole);

      // Immutable image pin via CDK context (-c dksIngestImageDigest / dksIngestImageTag).
      // Scoped :latest opt-out (own pipeline, not OMNI) — see forge-app note above.
      const dksIngestContainer = dksIngestTaskDef.addContainer('dks-ingest', {
        image: resolveEcrImage(this, dksIngestEcrRepo, 'dksIngest', { requireImmutable: false }),
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

      // -- ABC dataset ingest: S3 access on forge-platform-data/abc/* ---------
      // The ABC dataset (https://deep-geometry.github.io/abc-dataset/) is too
      // large for EFS-only staging. Pipeline:
      //   1. abc-stage-to-s3.yml      → curl chunk URLs into s3://.../abc/v00/raw/
      //   2. abc-extract-to-efs.yml   → unpack staged chunks to /data on EFS
      //   3. abc-build-index workflow → emit Parquet snapshot under abc/v00/index/
      // Bucket name follows the deterministic pattern from ForgeDataStack.
      const abcDataBucketName = legacyEnv
        ? `forge-platform-data-${this.account}-${this.region}`
        : `forge-platform-data-${this.account}-${this.region}-${props.forgeEnv}`;
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AbcDatasetS3ReadWrite',
        actions: [
          's3:PutObject',
          's3:PutObjectAcl',
          's3:GetObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        resources: [
          `arn:aws:s3:::${abcDataBucketName}/abc/*`,
        ],
      }));
      taskRole.addToPolicy(new iam.PolicyStatement({
        sid: 'AbcDatasetS3List',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [`arn:aws:s3:::${abcDataBucketName}`],
        conditions: {
          StringLike: { 's3:prefix': ['abc/*', 'abc'] },
        },
      }));

      // dks-download task definition (lightweight — for downloading datasets to EFS)
      const dksDownloadTaskDef = new ecs.FargateTaskDefinition(this, 'DksDownloadTaskDef', {
        family: scoped('dks-download'),
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
        // python:3.11-slim has python3 + pip baked in. We add awscli via pip
        // and a static 7zz binary fetched over HTTPS from GitHub Releases
        // (apt mirrors are unreliable from this Fargate subnet path).
        image: ecs.ContainerImage.fromRegistry('python:3.11-slim-bookworm'),
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
        value: scoped('/forge/ecs/dks-query'),
        description: 'DKS Query CloudWatch log group',
      });

      new cdk.CfnOutput(this, 'DksIngestTaskDefOutput', {
        value: dksIngestTaskDef.taskDefinitionArn,
        description: 'DKS Ingest task definition ARN (for run-task)',
      });

      new cdk.CfnOutput(this, 'DksIngestLogGroupOutput', {
        value: scoped('/forge/ecs/dks-ingest'),
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
      value: 'https://omni.qrucible.ai',
      description: 'OMNI endpoint used by forge-app (published ALB hostname; '
        + 'host-header routed to the forge-omni target on the shared ALB)',
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
