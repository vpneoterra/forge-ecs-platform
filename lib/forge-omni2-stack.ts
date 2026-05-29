/**
 * ForgeOmni2Stack -- OMNI2 (PicoGK 2.x) shadow service (Fargate)
 *
 * Deploys OMNI2 -- the PicoGK 2.x rebuild of OMNI with the fountain-pen
 * domain removed -- as a SECOND, fully parallel service on the SAME cluster
 * and ALB used by ForgeAppStack. This is strictly ADDITIVE and COEXISTS with
 * the live OMNI service: nothing about forge-omni (ECR, ECS service, the
 * priority-10 ALB rule, or omni.forge.local) is touched.
 *
 * Coexistence layout (OMNI unchanged | OMNI2 new):
 *   - ECR:       forge-omni        | forge-omni2
 *   - ECS svc:   forge-omni        | forge-omni2
 *   - Cloud Map: omni.forge.local  | omni2.forge.local   (both :5000)
 *   - ALB rule:  prio 10 omni.*    | prio 30 omni2.qrucible.ai
 *   - Log group: /forge/ecs/forge-omni | /forge/ecs/forge-omni2
 *
 * App config mirrors OMNI exactly (8192 CPU / 16384 MB, port 5000,
 * /api/health, the same DISPLAY/DOTNET/KNOWLEDGE/FluxTK/ENRICHMENT env and
 * the ANTHROPIC_API_KEY secret, FARGATE_SPOT w3 + FARGATE w1 base1). The
 * ALB-attach / Route53 / secret-by-name plumbing mirrors ForgeLucidStack.
 *
 * The ACM cert SAN for omni2.qrucible.ai is provisioned by ForgeAppStack via
 * the `omni2DomainName` prop (threaded from bin); see bin/forge-ecs-platform.ts.
 *
 * Source repo:  https://github.com/vpneoterra/forgenew  (docker/omni2, feat/omni2)
 * ECR repo:     forge-omni2
 *
 * Cost breakdown (incremental, shadow):
 *   - Fargate 8192/16384 (Spot w3 + 1 on-demand base): ~$72/month while running
 *   - CloudWatch Logs (7-day retention):               ~$0.50/month
 *   - Route 53 A-alias + ACM SAN:                      free
 *   Drop desiredCount to 0 (-c omni2Desired=0) to park the shadow at ~$0.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { ecsSecretByName } from './secret-lookup';

export interface ForgeOmni2StackProps extends cdk.StackProps {
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
  /** Public domain for OMNI2, e.g. 'omni2.qrucible.ai'. */
  domainName: string;
  /** Parent hosted zone, e.g. 'qrucible.ai'. */
  hostedZoneDomain: string;
  /**
   * Priority for the host-header rule on the shared HTTPS listener. Must be
   * unique. OMNI uses 10, LUCID uses 20, so 30 is the OMNI2 default.
   */
  listenerRulePriority?: number;
  /** Optional override for the ECR repo name (default: 'forge-omni2'). */
  ecrRepoName?: string;
  tags?: Record<string, string>;
}

export class ForgeOmni2Stack extends cdk.Stack {
  public readonly serviceName: string;
  public readonly internalEndpoint: string;
  public readonly publicUrl: string;

  constructor(scope: Construct, id: string, props: ForgeOmni2StackProps) {
    super(scope, id, props);

    const priority = props.listenerRulePriority ?? 30;
    const ecrRepoName = props.ecrRepoName ?? 'forge-omni2';

    // -- ECR repo (created out-of-band by create-omni2-ecr.yml / build-omni2.yml) --
    const ecrRepo = ecr.Repository.fromRepositoryName(this, 'Omni2Repo', ecrRepoName);

    // -- Hosted zone lookup --------------------------------------------------
    const hostedZone = route53.HostedZone.fromLookup(this, 'Omni2HostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // NOTE on ALB wiring: because props.httpsListener is the live listener
    // owned by ForgeAppStack, the addTargets() call below contributes the
    // OMNI2 target group + priority-30 host rule to the ForgeApp-dev stack
    // (CDK attaches listener mutations to the listener's OWNING stack), and
    // the omni2.qrucible.ai cert SAN is added there via the omni2DomainName
    // prop. This is the same mechanism by which OMNI (prio 10) and LUCID
    // (prio 20) rules live in ForgeApp-dev. It remains strictly additive:
    // the OMNI service, its priority-10 rule, and the existing SANs are
    // untouched -- only NEW resources are added. Deploy order: ForgeApp-dev
    // (adds SAN + rule + target group) then ForgeOmni2-dev (service, cloud
    // map, Route53).

    // -- Secret: ANTHROPIC_API_KEY (imported by bare name; never created) ----
    // Mirrors OMNI: OMNI2 uses the same Anthropic key binding.
    const anthropicKey = ecsSecretByName(this, 'Omni2AnthropicKey', 'ANTHROPIC_API_KEY');

    // -- CloudWatch log group ------------------------------------------------
    // Import by name (idempotent across rollbacks; first task write creates
    // it if absent). Distinct from OMNI's /forge/ecs/forge-omni group.
    const logGroup = logs.LogGroup.fromLogGroupName(
      this, 'Omni2LogGroup', '/forge/ecs/forge-omni2',
    );

    // -- Task roles ----------------------------------------------------------
    const executionRole = new iam.Role(this, 'Omni2ExecutionRole', {
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
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:*`,
      ],
    }));
    ecrRepo.grantPull(executionRole);

    const taskRole = new iam.Role(this, 'Omni2TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // ECS Exec for live debugging (parity with OMNI / forge-app).
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // -- Fargate task definition (mirrors OMNI 8192/16384) -------------------
    const cpu = Number(this.node.tryGetContext('omni2Cpu') ?? 8192);
    const memoryLimitMiB = Number(this.node.tryGetContext('omni2Memory') ?? 16384);

    const taskDef = new ecs.FargateTaskDefinition(this, 'Omni2TaskDef', {
      family: 'forge-omni2',
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Image tag / digest override (same rationale as LUCID): :latest is
    // referenced by NAME, so an out-of-band push of :latest yields a
    // byte-identical task def (no new revision, no auto-roll). Pin a digest
    //   -c omni2ImageDigest=sha256:...
    // to force a new revision per push, or force-new-deployment after a push.
    const omni2ImageTag = this.node.tryGetContext('omni2ImageTag') ?? 'latest';
    const omni2ImageDigest = this.node.tryGetContext('omni2ImageDigest') as
      | string
      | undefined;
    const omni2ImageRef = omni2ImageDigest
      ? (omni2ImageDigest.startsWith('sha256:')
          ? omni2ImageDigest
          : `sha256:${omni2ImageDigest}`)
      : String(omni2ImageTag);
    const omni2Image = ecs.ContainerImage.fromEcrRepository(ecrRepo, omni2ImageRef);

    const container = taskDef.addContainer('omni2-api', {
      image: omni2Image,
      essential: true,
      // Env mirrors OMNI exactly EXCEPT the internal Cloud Map identity, so
      // OMNI2 is independently reachable and never collides with OMNI.
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        KNOWLEDGE_SERVICE_URL: 'http://dks-query.forge.local:8020',
        // FluxTK conservation solver discovery (cross-namespace FQDN; see
        // FluxTK_ServiceDiscovery_RCA.md). Same as OMNI.
        FluxTK__BaseUrl: 'http://forge-fluxtk.forge-geometry.local:8040',
        // FORGE Node enrichment bridge (same target as OMNI).
        ENRICHMENT_BRIDGE_URL:
          'http://forge-app-test.forge.local:3000/api/omni-enriched',
        // OMNI2's own internal identity for self-reference / logging.
        OMNI_API_URL: 'http://omni2.forge.local:5000',
        OMNI_HOST: 'omni2.forge.local',
      },
      secrets: {
        ANTHROPIC_API_KEY: anthropicKey,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'omni2',
      }),
      healthCheck: {
        // Mirrors OMNI. The OMNI image ships wget; OMNI2 inherits the same
        // base, so wget is present.
        command: ['CMD-SHELL', 'wget -qO- http://localhost:5000/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        // PicoGK 2.x native kernel + headless GL cold start (parity w/ OMNI).
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    container.addPortMappings({ containerPort: 5000 });

    // -- Fargate service (Spot, private subnet, Cloud Map omni2) -------------
    const desiredCount = Number(this.node.tryGetContext('omni2Desired') ?? 1);

    const service = new ecs.FargateService(this, 'Omni2Service', {
      cluster: props.ecsCluster,
      taskDefinition: taskDef,
      desiredCount,
      serviceName: 'forge-omni2',
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
        name: 'omni2',
        cloudMapNamespace: props.cloudMapNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.serviceName = service.serviceName;
    this.internalEndpoint = 'http://omni2.forge.local:5000';
    this.publicUrl = `https://${props.domainName}`;

    // -- ALB attachment: handled OUT-OF-BAND (additive, CLI) -----------------
    // We deliberately do NOT call props.httpsListener.addTargets() here.
    // Because the HTTPS listener is owned by the (drifted, deploy-fragile)
    // ForgeApp-dev stack, addTargets() would attach the OMNI2 target group +
    // priority-30 rule + cert SAN to ForgeApp-dev, forcing a full ForgeApp
    // update -- which currently diffs to DESTROY DKS resources and has a
    // history of forge-app ECS circuit-breaker rollbacks. That is neither
    // additive nor safe. Instead, OMNI2's ALB wiring (target group, SNI cert
    // for omni2.qrucible.ai, priority-30 host rule, and service<->TG
    // attachment) is created additively via AWS CLI against the live ALB,
    // touching only NEW resources. See scripts/omni2-alb-wire.sh.
    // `priority` (default 30) is documented here for that out-of-band step.
    void priority;

    // -- Route 53 alias (omni2.qrucible.ai -> shared ALB) --------------------
    // The ACM cert on the shared ALB must include omni2.qrucible.ai as a SAN;
    // that is handled in ForgeAppStack via the `omni2DomainName` prop.
    new route53.ARecord(this, 'Omni2Alias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(props.alb as elbv2.ApplicationLoadBalancer),
      ),
      comment: 'OMNI2 ALB alias -- managed by CDK (additive shadow)',
    });

    // -- Outputs ------------------------------------------------------------
    new cdk.CfnOutput(this, 'Omni2PublicUrl', {
      value: this.publicUrl,
      description: 'OMNI2 public URL (Route 53 Alias -> shared ALB)',
    });
    new cdk.CfnOutput(this, 'Omni2InternalEndpoint', {
      value: this.internalEndpoint,
      description: 'OMNI2 internal endpoint via Cloud Map',
    });
    new cdk.CfnOutput(this, 'Omni2EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for OMNI2 images',
    });
    new cdk.CfnOutput(this, 'Omni2ServiceName', {
      value: service.serviceName,
      description: 'ECS service name for OMNI2',
    });
  }
}
