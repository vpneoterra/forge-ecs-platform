/**
 * ForgeGeometryStack -- Geometry Platform Infrastructure
 *
 * Deploys five geometry capabilities following the double-gate pattern:
 *   Gate 1: ECS service desiredCount (0 = dormant container exists but doesn't run)
 *   Gate 2: Feature flag env var in forge-app (false = no routing even if container is up)
 *
 * Architecture:
 *   - forge-brep: Fargate service (CPU-only, OpenCASCADE + CadQuery)
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
 * Cost with GPU active (g5.xlarge Spot): ~$220/month.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import {
  CONTAINER_CAPABILITIES,
  GPU_CAPABILITIES,
  CPU_CAPABILITIES,
  GeometryCapability,
  CAP_BREP,
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

  constructor(scope: Construct, id: string, props: ForgeGeometryStackProps) {
    super(scope, id, props);

    this.ecrRepos = new Map();
    this.taskDefinitions = new Map();
    this.services = new Map();

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
        logGroupName: `/forge/ecs/${cap.taskName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      logGroups.set(cap.id, lg);
    }

    // ── ECR Repositories ──────────────────────────────────────────────────────
    for (const cap of CONTAINER_CAPABILITIES) {
      const repo = new ecr.Repository(this, `Ecr${cap.id.replace(/-/g, '')}`, {
        repositoryName: cap.ecrRepo!,
        encryption: ecr.RepositoryEncryption.AES_256,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          { description: 'Remove untagged after 7d', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(7) },
          { description: 'Keep last 5', maxImageCount: 5 },
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
        `arn:aws:s3:::forge-platform-data-${this.account}-${this.region}`,
        `arn:aws:s3:::forge-platform-data-${this.account}-${this.region}/*`,
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
    );

    // ── Capability 2: GPU SDF Engine (EC2 GPU, desiredCount=0) ────────────────
    this.createGpuTaskDefinition(
      CAP_GPU_SDF,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_GPU_SDF.id)!,
    );

    // ── Capability 3: Neural SDF Engine (EC2 GPU, desiredCount=0) ─────────────
    this.createGpuTaskDefinition(
      CAP_NEURAL_SDF,
      props,
      taskExecutionRole,
      taskRole,
      logGroups.get(CAP_NEURAL_SDF.id)!,
    );

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
        'Cap 1 (B-Rep):        aws ecs update-service --cluster forge-geometry-' + props.forgeEnv + ' --service forge-brep --desired-count 1',
        'Cap 2 (GPU SDF):      Task definition ready. Create EC2 GPU service when needed.',
        'Cap 3 (Neural SDF):   Task definition ready. Create EC2 GPU service when needed.',
        'Cap 4 (ASG Editor):   Set ASG_EDITOR_ENABLED=true in forge-app env.',
        'Cap 5 (Field TPMS):   Set FIELD_DRIVEN_ENABLED=true in forge-app env.',
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
  ): void {
    const td = new ecs.FargateTaskDefinition(this, `Td${cap.id.replace(/-/g, '')}`, {
      family: cap.taskName!,
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

    const container = td.addContainer(`${cap.taskName}-container`, {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
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

    // Service starts with desiredCount=0 (dormant). Operator scales to 1 when activating.
    const service = new ecs.FargateService(this, `Svc${cap.id.replace(/-/g, '')}`, {
      cluster: this.geometryCluster,
      taskDefinition: td,
      serviceName: cap.taskName!,
      desiredCount: 0, // DORMANT — scale to 1 when activating Cap 1
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
  ): void {
    // GPU tasks use EC2 launch type on Provider C instances
    const td = new ecs.Ec2TaskDefinition(this, `Td${cap.id.replace(/-/g, '')}`, {
      family: cap.taskName!,
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    const repo = this.ecrRepos.get(cap.id)!;

    // GPU resource requirement — CDK doesn't have a native L2 for this,
    // so we add it via escape hatch after container creation
    const container = td.addContainer(`${cap.taskName}-container`, {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
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
}
