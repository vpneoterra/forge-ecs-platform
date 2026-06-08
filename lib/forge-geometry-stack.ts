/**
 * ForgeGeometryStack -- Geometry Platform Infrastructure
 *
 * Deploys six geometry capabilities following the double-gate pattern:
 *   Gate 1: ECS service desiredCount (0 = dormant container exists but doesn't run)
 *   Gate 2: Feature flag env var in forge-app (false = no routing even if container is up)
 *
 * Architecture:
 *   - forge-brep: Fargate service (CPU-only, OpenCASCADE + CadQuery)
 *   - forge-fluxtk: Fargate service (CPU-only, FastAPI + SciPy sparse solver)
 *   - forge-sdf-gpu: EC2 task on Provider C (GPU, libfive + NanoVDB) — desiredCount=0
 *   - forge-neural-sdf: EC2 task on Provider C (GPU, DeepSDF) — desiredCount=0
 *   - ASG Editor & Field-Driven TPMS: client-side only, no containers needed
 *
 * All feature flags deploy as 'false'. Operator activates per the runbook.
 *
 * Deployed conditionally via: -c deployGeometry=true
 *
 * Cost when all flags OFF: $0/hr incremental.
 * Cost with B-Rep active (Fargate Spot): ~$10/month.
 * Cost with FluxTK active (Fargate Spot): ~$5/month.
 * Cost with GPU active (g5.xlarge Spot): ~$220/month.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import {
  CONTAINER_CAPABILITIES,
  GPU_CAPABILITIES,
  CPU_CAPABILITIES,
  GeometryCapability,
  CAP_BREP,
  CAP_FLUXTK,
  CAP_PICOGK,
  CAP_GPU_SDF,
  CAP_NEURAL_SDF,
} from './config/geometry-manifest';

export interface ForgeGeometryStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  tags?: Record<string, string>;
}

export class ForgeGeometryStack extends cdk.Stack {
  /** ECR repositories for geometry containers */
  public readonly ecrRepos: Map<string, ecr.Repository>;
  /** ECS task definitions for geometry containers */
  public readonly taskDefinitions: Map<string, ecs.TaskDefinition>;
  /** ECS services for geometry containers */
  public readonly services: Map<string, ecs.BaseService>;
  /** The Fargate cluster for CPU geometry services */
  public readonly geometryCluster: ecs.Cluster;
  /** SNS topic for geometry-platform CloudWatch alarms */
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ForgeGeometryStackProps) {
    super(scope, id, props);

    this.ecrRepos = new Map();
    this.taskDefinitions = new Map();
    this.services = new Map();

    // 'dev' keeps the legacy flat physical names that the live blue stack
    // already uses; any other env (e.g. 'dev2') gets an env-suffixed name so
    // its account-unique resources (ECR repos, log groups, ECS service/task
    // families, alarms) don't collide with dev at change-set validation.
    // Same legacyEnv precedent as lib/forge-app-stack.ts. Scopes physical-name
    // PROPERTIES only; construct logical IDs are unchanged.
    const legacyEnv = props.forgeEnv === 'dev';
    const scoped = (base: string) => (legacyEnv ? base : `${base}-${props.forgeEnv}`);

    // ── ECS Cluster (Fargate + EC2 GPU) ───────────────────────────────────────
    // Reuses the forge-app pattern: Fargate for CPU, references existing Provider C for GPU
    this.geometryCluster = new ecs.Cluster(this, 'GeometryCluster', {
      clusterName: `forge-geometry-${props.forgeEnv}`,
      vpc: props.vpc,
      containerInsights: false, // Dev cost savings
      enableFargateCapacityProviders: true,
    });

    // ── Cloud Map namespace ───────────────────────────────────────────────────
    // Register geometry services in forge.local for inter-container discovery
    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(this, 'GeometryDns', {
      name: 'forge-geometry.local',
      vpc: props.vpc,
      description: 'FORGE Geometry Platform service discovery',
    });

    // ── CloudWatch Log Groups ─────────────────────────────────────────────────
    const logGroups = new Map<string, logs.LogGroup>();
    for (const cap of CONTAINER_CAPABILITIES) {
      const lg = new logs.LogGroup(this, `LogGroup${cap.id.replace(/-/g, '')}`, {
        logGroupName: `/forge/ecs/${scoped(cap.taskName!)}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      logGroups.set(cap.id, lg);
    }

    // ── ECR Repositories ──────────────────────────────────────────────────────
    for (const cap of CONTAINER_CAPABILITIES) {
      const repo = new ecr.Repository(this, `Ecr${cap.id.replace(/-/g, '')}`, {
        repositoryName: scoped(cap.ecrRepo!),
        encryption: ecr.RepositoryEncryption.AES_256,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        // NOTE: 30-day untagged retention. The task definition references images by
        // floating ':latest' tag (NOT digest-pinned at synth time), so untagged manifests
        // that get orphaned by a CI overwrite still need to live long enough that an
        // active ECS task never has its underlying digest GC'd from under it. 7 days
        // proved too aggressive in prod (see FluxTK 2026-05-24 outage).
        lifecycleRules: [
          { description: 'Remove untagged after 30d', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(30) },
          { description: 'Keep last 10 tagged', tagStatus: ecr.TagStatus.TAGGED, tagPatternList: ['*'], maxImageCount: 10 },
        ],
      });
      this.ecrRepos.set(cap.id, repo);
    }

    // ── IAM Roles ─────────────────────────────────────────────────────────────
    const taskExecutionRole = new iam.Role(this, 'GeometryExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameters', 'kms:Decrypt'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/*`],
    }));

    const taskRole = new iam.Role(this, 'GeometryTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // S3 for geometry data I/O
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [
        `arn:aws:s3:::${scoped(`forge-platform-data-${this.account}-${this.region}`)}`,
        `arn:aws:s3:::${scoped(`forge-platform-data-${this.account}-${this.region}`)}/*`,
      ],
    }));
    // ECS exec for debugging
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));
    // CloudWatch metrics
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // ── Capability 1: B-Rep / STEP Engine (Fargate, CPU-only) ─────────────────
    this.createFargateService(
      CAP_BREP,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_BREP.id)!,
      dnsNamespace,
      scoped(CAP_BREP.taskName!),
    );

    // ── Capability 6: FluxTK / BRAIDE Network Solver (Fargate, CPU-only) ─────
    this.createFargateService(
      CAP_FLUXTK,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_FLUXTK.id)!,
      dnsNamespace,
      scoped(CAP_FLUXTK.taskName!),
    );

    // ── Capability 7: PicoGK Voxel Geometry Engine (Fargate, CPU-only) ───────
    this.createFargateService(
      CAP_PICOGK,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_PICOGK.id)!,
      dnsNamespace,
      scoped(CAP_PICOGK.taskName!),
    );

    // ── Capability 2: GPU SDF Engine (EC2 GPU, desiredCount=0) ────────────────
    this.createGpuTaskDefinition(
      CAP_GPU_SDF,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_GPU_SDF.id)!,
      scoped(CAP_GPU_SDF.taskName!),
    );

    // ── Capability 3: Neural SDF Engine (EC2 GPU, desiredCount=0) ─────────────
    this.createGpuTaskDefinition(
      CAP_NEURAL_SDF,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_NEURAL_SDF.id)!,
      scoped(CAP_NEURAL_SDF.taskName!),
    );

    // ── SNS alarm topic for the geometry platform ────────────────────────────
    // Subscribers can be added out-of-band (operator email / PagerDuty / Slack webhook)
    // via the AWS console or a separate stack — we only own the topic here.
    this.alarmTopic = new sns.Topic(this, 'GeometryAlarmTopic', {
      topicName: `forge-geometry-alarms-${props.forgeEnv}`,
      displayName: `FORGE Geometry Platform Alarms (${props.forgeEnv})`,
    });
    new cdk.CfnOutput(this, 'GeometryAlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic ARN for geometry-platform CloudWatch alarms',
      exportName: `ForgeGeometryAlarmTopic-${props.forgeEnv}`,
    });

    // ── CloudWatch alarms per Fargate service ────────────────────────────────
    // Two alarms per service catch the FluxTK 2026-05-24 failure mode:
    //   1. RunningTaskCount<1 for 5 min  — service desired but ECS can't place a task
    //      (e.g. image pull failure from a GC'd digest, exhausted capacity, ENI limits).
    //   2. Log-group IncomingBytes<1024 for 30 min — task is up but emitting nothing
    //      (silent crash, deadlock, or zombie process).
    for (const cap of CPU_CAPABILITIES) {
      const service = this.services.get(cap.id);
      if (!service) continue;
      const logGroup = logGroups.get(cap.id)!;
      this.createServiceHealthAlarms(cap.id, scoped(cap.taskName!), service, logGroup);
    }

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GeometryClusterName', {
      value: this.geometryCluster.clusterName,
      description: 'Geometry ECS cluster name',
      exportName: `ForgeGeometryCluster-${props.forgeEnv}`,
    });

    for (const [capId, repo] of this.ecrRepos.entries()) {
      new cdk.CfnOutput(this, `EcrUri${capId.replace(/-/g, '')}`, {
        value: repo.repositoryUri,
        description: `ECR URI for ${capId}`,
        exportName: `ForgeGeometryEcr-${capId}-${props.forgeEnv}`,
      });
    }

    // Output activation instructions as stack metadata
    new cdk.CfnOutput(this, 'ActivationGuide', {
      value: [
        'GEOMETRY PLATFORM — All capabilities deployed OFF.',
        'Cap 1 (B-Rep):        aws ecs update-service --cluster forge-geometry-' + props.forgeEnv + ' --service ' + scoped(CAP_BREP.taskName!) + ' --desired-count 1',
        'Cap 6 (FluxTK):       aws ecs update-service --cluster forge-geometry-' + props.forgeEnv + ' --service ' + scoped(CAP_FLUXTK.taskName!) + ' --desired-count 1',
        'Cap PicoGK:           aws ecs update-service --cluster forge-geometry-' + props.forgeEnv + ' --service ' + scoped(CAP_PICOGK.taskName!) + ' --desired-count 1',
        'Cap 2 (GPU SDF):      Task definition ready. Create EC2 GPU service when needed.',
        'Cap 3 (Neural SDF):   Task definition ready. Create EC2 GPU service when needed.',
        'Cap 4 (ASG Editor):   Set ASG_EDITOR_ENABLED=true in forge-app env.',
        'Cap 5 (Field TPMS):   Set FIELD_DRIVEN_ENABLED=true in forge-app env. Requires Cap 6 (FluxTK) active.',
        'Then set the corresponding feature flag in forge-app .env and restart.',
      ].join('\n'),
      description: 'Geometry capability activation guide',
    });
  }

  // ── Fargate Service (CPU-only capabilities) ─────────────────────────────────

  private createFargateService(
    cap: GeometryCapability,
    props: ForgeGeometryStackProps,
    executionRole: iam.Role,
    taskRole: iam.Role,
    logGroup: logs.LogGroup,
    dnsNamespace: servicediscovery.PrivateDnsNamespace,
    scopedName: string,
  ): void {
    const td = new ecs.FargateTaskDefinition(this, `Td${cap.id.replace(/-/g, '')}`, {
      family: scopedName,
      cpu: cap.cpu!,
      memoryLimitMiB: cap.memory!,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const repo = this.ecrRepos.get(cap.id)!;

    // IMPORTANT: use fromRegistry with an explicit string URL instead of
    // fromEcrRepository(repo, 'latest'). The L2 helper resolves ':latest' to
    // an immutable '@sha256:<digest>' at CDK synth time and bakes it into the
    // CFN template, so when CI overwrites ':latest' the task-def still pulls
    // the old digest — which is then orphaned and eventually GC'd by ECR
    // lifecycle, leaving the service unable to pull any image. With the
    // string form, the task-def stores a literal floating tag and ECS pulls
    // whichever digest ':latest' resolves to at task start. The execution
    // role already grants the required ecr:GetAuthorizationToken /
    // BatchGetImage permissions via AmazonECSTaskExecutionRolePolicy.
    // Image URI references the SAME scoped repo name so it's internally
    // consistent. For non-dev envs the scoped repo (e.g. forge-brep-dev2) is
    // intentionally EMPTY until CI pushes images; this does not block CREATE
    // because every geometry service deploys dormant (desiredCount=0,
    // activateOnDeploy=false), so no task is started against the empty repo.
    // Image ref: floating-':latest' string by default; immutable digest/tag when
    // an override is supplied (see geometryImage()).
    // Preserve CFN ordering: the task-def must come after the ECR repo construct.
    td.node.addDependency(repo);

    const container = td.addContainer(`${cap.taskName}-container`, {
      image: this.geometryImage(cap, scopedName),
      essential: true,
      environment: {
        ...cap.containerEnvVars,
        AWS_REGION: this.region,
        FORGE_ENV: props.forgeEnv,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: cap.taskName!,
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${cap.port}${cap.healthCheckPath} || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120), // OpenCASCADE init takes time
      },
      portMappings: [{
        containerPort: cap.port!,
        protocol: ecs.Protocol.TCP,
      }],
    });

    this.taskDefinitions.set(cap.id, td);

    // Capability manifest controls initial activation:
    //   activateOnDeploy=false → desiredCount=0 (dormant; operator scales to 1 later)
    //   activateOnDeploy=true  → desiredCount=1 (hot on deploy)
    const service = new ecs.FargateService(this, `Svc${cap.id.replace(/-/g, '')}`, {
      cluster: this.geometryCluster,
      taskDefinition: td,
      serviceName: scopedName,
      desiredCount: cap.activateOnDeploy ? 1 : 0,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSecurityGroup],
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
      cloudMapOptions: {
        name: cap.cloudMapName!,
        cloudMapNamespace: dnsNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    this.services.set(cap.id, service);
  }

  // ── Per-service health alarms ───────────────────────────────────────────────
  // Catches the two silent-failure modes observed in the FluxTK 2026-05-24 outage:
  //   (a) service desired=1 but ECS cannot start a task (image pull fail, etc.)
  //   (b) task running but emitting no logs (zombie / deadlocked process)
  private createServiceHealthAlarms(
    capId: string,
    serviceName: string,
    service: ecs.BaseService,
    logGroup: logs.LogGroup,
  ): void {
    const safeId = capId.replace(/-/g, '');

    // (a) RunningTaskCount<1 for 5 consecutive minutes.
    // Uses the AWS/ECS namespace (always emitted, no Container Insights required).
    const runningTasksMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'RunningTaskCount',
      dimensionsMap: {
        ClusterName: this.geometryCluster.clusterName,
        ServiceName: serviceName,
      },
      statistic: 'Maximum',
      period: cdk.Duration.seconds(60),
    });
    const noTasksAlarm = new cloudwatch.Alarm(this, `AlarmNoTasks${safeId}`, {
      alarmName: `forge-geometry-${serviceName}-no-running-tasks`,
      alarmDescription:
        `ECS service ${serviceName} has had 0 running tasks for 5 minutes. ` +
        `Likely causes: image pull failure (orphaned digest), capacity exhaustion, ` +
        `or task crash-loop. Investigate stopped-task reasons immediately.`,
      metric: runningTasksMetric,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    noTasksAlarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));
    noTasksAlarm.addOkAction(new cwActions.SnsAction(this.alarmTopic));
    // Force the alarm to depend on the service so it is created after the metric exists.
    noTasksAlarm.node.addDependency(service);

    // (b) Log IncomingBytes<1024 sum over 30 minutes (6 × 5-minute periods).
    // Empty/near-empty log group while the service is supposedly running indicates
    // a silent failure (e.g. process started but never connected, deadlocked solver).
    const logBytesMetric = new cloudwatch.Metric({
      namespace: 'AWS/Logs',
      metricName: 'IncomingBytes',
      dimensionsMap: {
        LogGroupName: logGroup.logGroupName,
      },
      statistic: 'Sum',
      period: cdk.Duration.seconds(300),
    });
    const silentLogsAlarm = new cloudwatch.Alarm(this, `AlarmSilentLogs${safeId}`, {
      alarmName: `forge-geometry-${serviceName}-silent-logs`,
      alarmDescription:
        `Log group ${logGroup.logGroupName} received <1 KiB in 30 minutes. ` +
        `Service may be running but not processing requests, or stuck in a zombie state.`,
      metric: logBytesMetric,
      threshold: 1024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 6,
      datapointsToAlarm: 6,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // log group may not yet exist on first deploy
    });
    silentLogsAlarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));
    silentLogsAlarm.node.addDependency(logGroup);
  }

  // ── GPU Task Definition (desiredCount=0 — task def only, no service) ────────
  // GPU services are NOT created as ECS services. Instead, we register the task
  // definition so it can be launched via RunTask (Step Functions or CLI) on
  // Provider C when the operator is ready to activate.

  private createGpuTaskDefinition(
    cap: GeometryCapability,
    props: ForgeGeometryStackProps,
    executionRole: iam.Role,
    taskRole: iam.Role,
    logGroup: logs.LogGroup,
    scopedName: string,
  ): void {
    // GPU tasks use EC2 launch type on Provider C instances
    const td = new ecs.Ec2TaskDefinition(this, `Td${cap.id.replace(/-/g, '')}`, {
      family: scopedName,
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    const repo = this.ecrRepos.get(cap.id)!;

    // See note in createFargateService — string-form image URI prevents the
    // synth-time '@sha256:<digest>' pin that caused the FluxTK outage. Uses the
    // SAME scoped repo name (non-dev repos are intentionally empty until CI
    // pushes; GPU tasks run only via operator RunTask, so CREATE is not blocked).
    td.node.addDependency(repo);

    // GPU resource requirement — CDK doesn't have a native L2 for this,
    // so we add it via escape hatch after container creation.
    // Image ref: floating-':latest' string by default; immutable digest/tag when
    // an override is supplied (see geometryImage()).
    const container = td.addContainer(`${cap.taskName}-container`, {
      image: this.geometryImage(cap, scopedName),
      cpu: cap.cpu!,
      memoryLimitMiB: cap.memory!,
      essential: true,
      environment: {
        ...cap.containerEnvVars,
        AWS_REGION: this.region,
        FORGE_ENV: props.forgeEnv,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: cap.taskName!,
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${cap.port}${cap.healthCheckPath} || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(180), // GPU model loading takes time
      },
      portMappings: [{
        containerPort: cap.port!,
        hostPort: cap.port!,
        protocol: ecs.Protocol.TCP,
      }],
    });

    // Add GPU resource requirement via L1 escape hatch
    const cfnTd = td.node.defaultChild as cdk.CfnResource;
    cfnTd.addOverride(
      `Properties.ContainerDefinitions.0.ResourceRequirements`,
      [{ Type: 'GPU', Value: '1' }],
    );

    this.taskDefinitions.set(cap.id, td);

    // NOTE: No ECS Service created for GPU capabilities.
    // To activate, the operator creates a service on the solver cluster (Provider C)
    // or runs the task via Step Functions / CLI:
    //   aws ecs run-task --cluster forge-dev --task-definition forge-sdf-gpu \
    //     --capacity-provider-strategy capacityProvider=ForgeProviderC,weight=1 \
    //     --network-configuration ...
  }

  /**
   * Resolve the container image for a geometry capability.
   *
   * DEFAULT (no override): keep the deliberate floating-':latest' STRING form
   * via fromRegistry. This stores a literal tag in the task-def so ECS resolves
   * the digest at task start — cold starts always pull current ':latest' and are
   * never broken by a ':latest' overwrite (this is what avoided a repeat of the
   * FluxTK synth-time-digest-pin outage).
   *
   * OVERRIDE (recommended for deploys): pass an immutable pin via CDK context so
   * each push yields a new task-def revision and ECS auto-rolls the service:
   *   -c <taskName camelCased>ImageDigest=sha256:...   (preferred)
   *   -c <taskName camelCased>ImageTag=<git-sha>
   * e.g. forge-picogk -> forgePicogkImageDigest / forgePicogkImageTag.
   */
  private geometryImage(cap: GeometryCapability, scopedName: string): ecs.ContainerImage {
    const prefix = cap.taskName!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const digest = this.node.tryGetContext(`${prefix}ImageDigest`) as string | undefined;
    const tag = this.node.tryGetContext(`${prefix}ImageTag`) as string | undefined;
    const base = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${scopedName}`;
    if (digest) {
      const d = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
      return ecs.ContainerImage.fromRegistry(`${base}@${d}`);
    }
    if (tag) {
      return ecs.ContainerImage.fromRegistry(`${base}:${tag}`);
    }
    // Backwards-compatible safe default: literal floating ':latest' string.
    return ecs.ContainerImage.fromRegistry(`${base}:latest`);
  }
}
