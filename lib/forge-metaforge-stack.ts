/**
 * ForgeMetaForgeStack -- Omnigent server (the Meta-Forge control plane substrate)
 *
 * Deploys the Omnigent server from the fork `vpneoterra/omnigent` on the SAME
 * Fargate cluster + shared ALB used by ForgeAppStack, exactly like
 * ForgeLucidStack does for LUCID. This is the meta-harness platform that
 * Meta-Forge (Part II) builds on; it is NOT the OMNI/PicoGK renderer
 * (forge-omni) -- different service, despite the similar name.
 *
 * Differences from ForgeLucidStack (all grounded in the Omnigent deploy docs):
 *   - Container port 8000 (Dockerfile EXPOSEs 8000), not 3000.
 *   - Persistent /data on EFS (artifacts + admin-credentials + cookie secret +
 *     config.yaml). MUST survive task replacement; Fargate ephemeral storage
 *     does not. EFS supports multi-mount, so >1 replica is fine WITH Postgres.
 *   - Health-check start period 120 s: first boot runs DB migrations over the
 *     network (~1 min) before readiness; too short a grace loops the deploy.
 *   - DATABASE_URL (Postgres) is required for >1 replica. Provided as a secret.
 *   - OMNIGENT_ACCOUNTS_BASE_URL set explicitly: there is no RENDER_EXTERNAL_URL
 *     on ECS, so invite/callback links won't auto-resolve.
 *
 * Image strategy: the fork publishes NO GHCR package, and the web UI SPA bundle
 * is gitignored, so a plain source build ships without a UI. Build the
 * multi-stage Dockerfile `--target server` (its web-builder stage compiles
 * ap-web) and push to the ECR repo `metaforge`. See scripts/metaforge-build.sh.
 *
 * Operator-provisioned Secrets Manager entries (imported by bare name, never
 * created here), mirroring the LUCID secret idiom:
 *   METAFORGE_DATABASE_URL          (Postgres; required for multi-replica)
 *   METAFORGE_OIDC_COOKIE_SECRET    (openssl rand -hex 32; bytes.fromhex requires hex)
 *   METAFORGE_OIDC_CLIENT_SECRET    (only in oidc mode)
 *
 * Cost (incremental, parity with LUCID): Fargate Spot 512/1024 ~$6/mo +
 * EFS (~10 GiB, mostly idle) ~$3/mo + CloudWatch logs ~$0.5/mo. ~$10/mo.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { ecsSecretByName } from './secret-lookup';

export interface ForgeMetaForgeStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  /** Existing ECS cluster from ForgeAppStack. */
  ecsCluster: ecs.ICluster;
  /** Shared ALB from ForgeAppStack. */
  alb: elbv2.IApplicationLoadBalancer;
  /** Shared HTTPS (443) listener. The shared cert MUST include domainName as a SAN. */
  httpsListener: elbv2.IApplicationListener;
  /** Shared Cloud Map namespace (forge.local). */
  cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  /** Public domain, e.g. 'metaforge.qrucible.ai'. */
  domainName: string;
  /** Parent hosted zone, e.g. 'qrucible.ai'. */
  hostedZoneDomain: string;
  /** Unique host-header rule priority. OMNI=10, LUCID=20 -> use 30. */
  listenerRulePriority?: number;
  /** ECR repo name (default: 'metaforge'). Created out-of-band by the build script / build-images.yml. */
  ecrRepoName?: string;
  /** Auth provider: 'accounts' | 'oidc' | 'header' (default: 'accounts'). */
  authProvider?: string;
  /** In 'header' mode, the identity header injected by the ALB/edge. */
  authHeader?: string;
  /** OIDC issuer / client id / redirect (secrets handled separately) -- only in 'oidc' mode. */
  oidcIssuer?: string;
  oidcClientId?: string;
  tags?: Record<string, string>;
}

export class ForgeMetaForgeStack extends cdk.Stack {
  public readonly serviceName: string;
  public readonly publicUrl: string;
  public readonly internalEndpoint: string;

  constructor(scope: Construct, id: string, props: ForgeMetaForgeStackProps) {
    super(scope, id, props);

    const priority = props.listenerRulePriority ?? 30;
    const ecrRepoName = props.ecrRepoName ?? 'metaforge';
    const authProvider = props.authProvider ?? 'accounts';

    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'MetaForgeRepo', ecrRepoName);
    const hostedZone = route53.HostedZone.fromLookup(this, 'MfHostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- Secrets (imported by bare name; never created/mutated here) ---------
    const databaseUrl = ecsSecretByName(this, 'MfDatabaseUrl', 'METAFORGE_DATABASE_URL');
    const cookieSecret = ecsSecretByName(this, 'MfCookieSecret', 'METAFORGE_OIDC_COOKIE_SECRET');
    // Only bound when authProvider === 'oidc'.
    const oidcClientSecret =
      authProvider === 'oidc'
        ? ecsSecretByName(this, 'MfOidcClientSecret', 'METAFORGE_OIDC_CLIENT_SECRET')
        : undefined;

    // -- Persistent /data on EFS (artifacts, admin-credentials, config.yaml) -
    // Created and owned by this stack (the app stack's EFS is a separate
    // mesh store). Multi-AZ mount targets; NFS:2049 from the shared ECS SG.
    const dataEfs = new efs.FileSystem(this, 'MetaForgeData', {
      vpc: props.vpc,
      vpcSubnets: { subnets: props.privateSubnets },
      securityGroup: props.ecsSecurityGroup,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      // Persistent system-of-record for artifacts + admin creds: RETAIN.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    dataEfs.connections.allowDefaultPortFrom(props.ecsSecurityGroup);
    // The Omnigent image runs as a non-root user; uid/gid 1000 matches the
    // LUCID/DKS access-point convention used elsewhere in this platform.
    const dataAccessPoint = dataEfs.addAccessPoint('MetaForgeDataAP', {
      path: '/data',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '755' },
      posixUser: { uid: '1000', gid: '1000' },
    });

    // -- Log group (env-scoped; create-and-own for non-legacy envs) ----------
    const logGroupName = `/forge/ecs/metaforge-${props.forgeEnv}`;
    const logGroup = new logs.LogGroup(this, 'MetaForgeLogGroup', {
      logGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -- Roles ---------------------------------------------------------------
    const executionRole = new iam.Role(this, 'MfExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`],
    }));
    ecrRepo.grantPull(executionRole);

    const taskRole = new iam.Role(this, 'MfTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // EFS client mount + write (artifacts/admin-credentials are read AND written).
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      resources: [dataEfs.fileSystemArn],
    }));
    // ECS Exec for live debugging (parity with forge-app/lucid).
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // -- Task definition -----------------------------------------------------
    const cpu = Number(this.node.tryGetContext('metaForgeCpu') ?? 512);
    const memoryLimitMiB = Number(this.node.tryGetContext('metaForgeMemory') ?? 1024);

    const taskDef = new ecs.FargateTaskDefinition(this, 'MetaForgeTaskDef', {
      family: `metaforge-${props.forgeEnv}`,
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // EFS volume + mount at /data.
    taskDef.addVolume({
      name: 'metaforge-data',
      efsVolumeConfiguration: {
        fileSystemId: dataEfs.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: dataAccessPoint.accessPointId, iam: 'ENABLED' },
      },
    });

    // Image ref: prefer an immutable digest so each push rolls the service.
    //   -c metaForgeImageDigest=sha256:...   (preferred)
    //   -c metaForgeImageTag=<tag>           (falls back to :latest)
    const tag = this.node.tryGetContext('metaForgeImageTag') ?? 'latest';
    const digest = this.node.tryGetContext('metaForgeImageDigest') as string | undefined;
    const imageRef = digest
      ? (digest.startsWith('sha256:') ? digest : `sha256:${digest}`)
      : String(tag);
    const image = ecs.ContainerImage.fromEcrRepository(ecrRepo, imageRef);

    const environment: Record<string, string> = {
      HOST: '0.0.0.0',
      ARTIFACT_DIR: '/data/artifacts',
      OMNIGENT_ADMIN_CREDENTIALS_PATH: '/data/admin-credentials',
      OMNIGENT_CONFIG: '/data/config.yaml',
      OMNIGENT_AUTH_ENABLED: '1',
      OMNIGENT_AUTH_PROVIDER: authProvider,
      // No RENDER_EXTERNAL_URL on ECS -> set the public base URL explicitly.
      OMNIGENT_ACCOUNTS_BASE_URL: `https://${props.domainName}`,
    };
    if (authProvider === 'header' && props.authHeader) {
      environment.OMNIGENT_AUTH_HEADER = props.authHeader;
    }
    if (authProvider === 'oidc') {
      if (props.oidcIssuer) environment.OMNIGENT_OIDC_ISSUER = props.oidcIssuer;
      if (props.oidcClientId) environment.OMNIGENT_OIDC_CLIENT_ID = props.oidcClientId;
      environment.OMNIGENT_OIDC_REDIRECT_URI = `https://${props.domainName}/auth/callback`;
    }

    const secrets: Record<string, ecs.Secret> = {
      DATABASE_URL: databaseUrl,
      OMNIGENT_OIDC_COOKIE_SECRET: cookieSecret,
    };
    if (oidcClientSecret) secrets.OMNIGENT_OIDC_CLIENT_SECRET = oidcClientSecret;

    const container = taskDef.addContainer('metaforge', {
      image,
      essential: true,
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'metaforge' }),
      healthCheck: {
        // curl ships in the Omnigent server image; /health is the documented probe.
        command: ['CMD-SHELL', 'curl -fsS http://localhost:8000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        // First boot runs DB migrations over the network (~1 min). 120 s grace.
        startPeriod: cdk.Duration.seconds(120),
      },
    });
    container.addPortMappings({ containerPort: 8000 });
    container.addMountPoints({
      containerPath: '/data',
      sourceVolume: 'metaforge-data',
      readOnly: false,
    });

    // -- Service -------------------------------------------------------------
    // desiredCount default 1. >1 is SAFE here (EFS multi-mount + Postgres),
    // but only raise it once METAFORGE_DATABASE_URL points at Postgres, never
    // SQLite. Guarded below.
    const desired = Number(this.node.tryGetContext('metaForgeDesiredCount') ?? 1);

    const service = new ecs.FargateService(this, 'MetaForgeService', {
      cluster: props.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: desired,
      serviceName: `metaforge-${props.forgeEnv}`,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      // The server is stateful-on-/data but the state lives on EFS, not the
      // task; on-demand base task for availability through Spot interruptions.
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },
        { capacityProvider: 'FARGATE', weight: 1, base: 1 },
      ],
      cloudMapOptions: {
        name: 'metaforge',
        cloudMapNamespace: props.cloudMapNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.serviceName = service.serviceName;
    this.internalEndpoint = 'http://metaforge.forge.local:8000';
    this.publicUrl = `https://${props.domainName}`;

    // -- ALB host-header target ---------------------------------------------
    props.httpsListener.addTargets('MetaForgeTarget', {
      targets: [service],
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority,
      conditions: [elbv2.ListenerCondition.hostHeaders([props.domainName])],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyHttpCodes: '200',
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      // WebSocket sessions: keep connections drained gently.
      deregistrationDelay: cdk.Duration.seconds(30),
      // Omnigent uses WebSockets for live sessions; ALB sticky not required
      // (state is on EFS/Postgres), but lengthen idle timeout at the ALB
      // level if long-lived streams drop (set on the ALB, not here).
    });

    new route53.ARecord(this, 'MetaForgeAlias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(props.alb as elbv2.ApplicationLoadBalancer),
      ),
      comment: 'Meta-Forge (Omnigent server) ALB alias -- managed by CDK',
    });

    // -- Outputs -------------------------------------------------------------
    new cdk.CfnOutput(this, 'MetaForgePublicUrl', { value: this.publicUrl });
    new cdk.CfnOutput(this, 'MetaForgeEcrRepoUri', { value: ecrRepo.repositoryUri });
    new cdk.CfnOutput(this, 'MetaForgeServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'MetaForgeDataEfsId', { value: dataEfs.fileSystemId });
    new cdk.CfnOutput(this, 'MetaForgeAuthProvider', { value: authProvider });
  }
}
