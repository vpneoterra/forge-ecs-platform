/**
 * ForgeComputeStack — THE CORE
 *
 * ECS cluster with 3 managed capacity providers:
 *   Provider A: Graviton Spot c6g.xlarge (always-on, $51/month)
 *   Provider B: x86 Spot c5/c6i (scale-to-zero heavy compute)
 *   Provider C: GPU Spot g5.xlarge (scale-to-zero, pay-per-use)
 *
 * 8 ECS task definitions, 4 always-on services, 4 SQS-driven scale-to-zero tasks.
 * Cloud Map private DNS: forge.local
 * ALB skipped for dev — Nginx in forge-devops handles routing via Elastic IP.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { SOLVER_MANIFEST, ALWAYS_ON_TASKS, SQS_DRIVEN_TASKS, SolverTask } from './config/solver-manifest';
import { PROVIDER_A, PROVIDER_B, PROVIDER_C } from './config/capacity-providers';

export interface ForgeComputeStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  dataBucket: s3.Bucket;
  efsFilesystem: efs.FileSystem;
  jobsTable: dynamodb.Table;
  ecrRepos: Map<string, ecr.Repository>;
  rdsEndpoint: string;
  tags?: Record<string, string>;
}

export class ForgeComputeStack extends cdk.Stack {
  public readonly ecsCluster: ecs.Cluster;
  public readonly taskDefinitions: Map<string, ecs.Ec2TaskDefinition>;
  public readonly sqsQueues: Map<string, sqs.Queue>;
  public readonly services: Map<string, ecs.Ec2Service>;

  constructor(scope: Construct, id: string, props: ForgeComputeStackProps) {
    super(scope, id, props);

    const isProd = props.forgeEnv === 'prod';

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    this.ecsCluster = new ecs.Cluster(this, 'ForgeCluster', {
      clusterName: `forge-${props.forgeEnv}`,
      vpc: props.vpc,
      containerInsights: isProd, // Costs extra ($0.40/GB) — disable for dev
      enableFargateCapacityProviders: false, // We use EC2 only (no Fargate — too expensive)
    });

    // ── Cloud Map: forge.local ────────────────────────────────────────────────
    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(this, 'ForgeDns', {
      name: 'forge.local',
      vpc: props.vpc,
      description: 'FORGE service discovery namespace',
    });

    // ── CloudWatch Log Groups ─────────────────────────────────────────────────
    const logGroups = new Map<string, logs.LogGroup>();
    for (const task of SOLVER_MANIFEST) {
      const lg = new logs.LogGroup(this, `LogGroup${task.name.replace(/-/g, '')}`, {
        logGroupName: `/forge/ecs/${task.name}`,
        retention: logs.RetentionDays.ONE_WEEK, // 7-day retention = low cost
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      logGroups.set(task.name, lg);
    }

    // ── ECS Task Execution Role (shared) ──────────────────────────────────────
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    // Allow reading secrets (for DB passwords, API keys)
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'ssm:GetParameters', 'kms:Decrypt'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/*`],
    }));

    // ── ECS Task Role (runtime permissions) ───────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // S3 read/write for data bucket
    props.dataBucket.grantReadWrite(taskRole);
    // DynamoDB for job state
    props.jobsTable.grantReadWriteData(taskRole);
    // SQS — will add specific queue permissions below
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage',
        'sqs:GetQueueAttributes', 'sqs:GetQueueUrl',
      ],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:forge-*`],
    }));
    // ECS exec (for debugging)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));
    // CloudWatch metrics publishing
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // ── ASG + Capacity Provider A (Graviton Spot, always-on) ──────────────────
    const asgA = new autoscaling.AutoScalingGroup(this, 'AsgA', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.ecsSecurityGroup,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0, // 100% Spot
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
        launchTemplate: new ec2.LaunchTemplate(this, 'LtA', {
          machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.ARM),
          instanceType: new ec2.InstanceType(PROVIDER_A.instanceTypes[0]),
          role: new iam.Role(this, 'InstanceRoleA', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerServiceforEC2Role'),
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
          }),
          userData: ec2.UserData.forLinux(),
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: autoscaling.BlockDeviceVolume.ebs(30, {
              volumeType: autoscaling.EbsDeviceVolumeType.GP3,
              encrypted: true,
              deleteOnTermination: true,
            }),
          }],
        }),
        launchTemplateOverrides: PROVIDER_A.instanceTypes.map(it => ({
          instanceType: new ec2.InstanceType(it),
          launchTemplateSpec: undefined,
        })),
      },
      minCapacity: PROVIDER_A.minCapacity,
      maxCapacity: PROVIDER_A.maxCapacity,
      newInstancesProtectedFromScaleIn: true,
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });

    // Add ECS user data to register instances with cluster
    const userDataA = asgA.userData;
    userDataA.addCommands(
      `echo ECS_CLUSTER=${this.ecsCluster.clusterName} >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_CONTAINER_METADATA=true >> /etc/ecs/ecs.config`,
    );

    const capacityProviderA = new ecs.AsgCapacityProvider(this, 'CapacityProviderA', {
      autoScalingGroup: asgA,
      capacityProviderName: PROVIDER_A.name,
      enableManagedScaling: true,
      targetCapacityPercent: PROVIDER_A.targetCapacityPercent,
      enableManagedTerminationProtection: true,
      enableManagedDraining: true,
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
    });
    this.ecsCluster.addAsgCapacityProvider(capacityProviderA);

    // ── ASG + Capacity Provider B (x86 Spot, scale-to-zero) ───────────────────
    const asgB = new autoscaling.AutoScalingGroup(this, 'AsgB', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.ecsSecurityGroup,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
        launchTemplate: new ec2.LaunchTemplate(this, 'LtB', {
          machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
          instanceType: new ec2.InstanceType(PROVIDER_B.instanceTypes[0]),
          role: new iam.Role(this, 'InstanceRoleB', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerServiceforEC2Role'),
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
          }),
          userData: ec2.UserData.forLinux(),
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: autoscaling.BlockDeviceVolume.ebs(50, {
              volumeType: autoscaling.EbsDeviceVolumeType.GP3,
              encrypted: true,
              deleteOnTermination: true,
            }),
          }],
        }),
        launchTemplateOverrides: PROVIDER_B.instanceTypes.map(it => ({
          instanceType: new ec2.InstanceType(it),
          launchTemplateSpec: undefined,
        })),
      },
      minCapacity: PROVIDER_B.minCapacity, // 0 = scale-to-zero
      maxCapacity: PROVIDER_B.maxCapacity,
      newInstancesProtectedFromScaleIn: false, // Allow aggressive scale-in
    });

    const userDataB = asgB.userData;
    userDataB.addCommands(
      `echo ECS_CLUSTER=${this.ecsCluster.clusterName} >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_CONTAINER_METADATA=true >> /etc/ecs/ecs.config`,
    );

    const capacityProviderB = new ecs.AsgCapacityProvider(this, 'CapacityProviderB', {
      autoScalingGroup: asgB,
      capacityProviderName: PROVIDER_B.name,
      enableManagedScaling: true,
      targetCapacityPercent: PROVIDER_B.targetCapacityPercent, // 100% — max bin-packing
      enableManagedTerminationProtection: false,
      enableManagedDraining: true,
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
    });
    this.ecsCluster.addAsgCapacityProvider(capacityProviderB);

    // ── ASG + Capacity Provider C (GPU Spot, scale-to-zero) ────────────────────
    const asgC = new autoscaling.AutoScalingGroup(this, 'AsgC', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.ecsSecurityGroup,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: 0,
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.LOWEST_PRICE,
        },
        launchTemplate: new ec2.LaunchTemplate(this, 'LtC', {
          // GPU instances require Amazon Linux 2 with GPU AMI
          machineImage: ec2.MachineImage.lookup({
            name: 'amzn2-ami-ecs-gpu-hvm-*-x86_64-ebs',
            owners: ['amazon'],
          }),
          instanceType: new ec2.InstanceType(PROVIDER_C.instanceTypes[0]),
          role: new iam.Role(this, 'InstanceRoleC', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerServiceforEC2Role'),
              iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
          }),
          userData: ec2.UserData.forLinux(),
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: autoscaling.BlockDeviceVolume.ebs(100, {
              volumeType: autoscaling.EbsDeviceVolumeType.GP3,
              encrypted: true,
              deleteOnTermination: true,
            }),
          }],
        }),
        launchTemplateOverrides: PROVIDER_C.instanceTypes.map(it => ({
          instanceType: new ec2.InstanceType(it),
          launchTemplateSpec: undefined,
        })),
      },
      minCapacity: PROVIDER_C.minCapacity, // 0 = no instances unless triggered
      maxCapacity: PROVIDER_C.maxCapacity,
      newInstancesProtectedFromScaleIn: false,
    });

    const userDataC = asgC.userData;
    userDataC.addCommands(
      `echo ECS_CLUSTER=${this.ecsCluster.clusterName} >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config`,
    );

    const capacityProviderC = new ecs.AsgCapacityProvider(this, 'CapacityProviderC', {
      autoScalingGroup: asgC,
      capacityProviderName: PROVIDER_C.name,
      enableManagedScaling: true,
      targetCapacityPercent: PROVIDER_C.targetCapacityPercent,
      enableManagedTerminationProtection: false,
      enableManagedDraining: true,
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
    });
    this.ecsCluster.addAsgCapacityProvider(capacityProviderC);

    // ── SQS Queues (for scale-to-zero tasks) ──────────────────────────────────
    this.sqsQueues = new Map<string, sqs.Queue>();

    for (const task of SQS_DRIVEN_TASKS) {
      if (!task.sqsQueueName) continue;

      // Dead-letter queue — receives messages that fail after 3 attempts
      const dlq = new sqs.Queue(this, `Dlq${task.name.replace(/-/g, '')}`, {
        queueName: `${task.sqsQueueName.replace('.fifo', '-dlq')}.fifo`,
        fifo: true,
        retentionPeriod: cdk.Duration.days(14), // Keep failed jobs 14 days
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      });

      const queue = new sqs.Queue(this, `Queue${task.name.replace(/-/g, '')}`, {
        queueName: task.sqsQueueName,
        fifo: true,
        contentBasedDeduplication: true,
        visibilityTimeout: cdk.Duration.hours(6), // Long timeout for HPC jobs
        retentionPeriod: cdk.Duration.days(4),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: 3,
        },
      });

      this.sqsQueues.set(task.name, queue);
    }

    // ── Task Definitions ──────────────────────────────────────────────────────
    this.taskDefinitions = new Map<string, ecs.Ec2TaskDefinition>();
    this.services = new Map<string, ecs.Ec2Service>();

    for (const task of SOLVER_MANIFEST) {
      const td = this.createTaskDefinition(task, props, taskExecutionRole, taskRole, logGroups);
      this.taskDefinitions.set(task.name, td);
    }

    // ── ECS Services (always-on tasks) ────────────────────────────────────────
    for (const task of ALWAYS_ON_TASKS) {
      const service = this.createAlwaysOnService(
        task, props, dnsNamespace, capacityProviderA,
      );
      this.services.set(task.name, service);
    }

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: `ForgeClusterName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.ecsCluster.clusterArn,
      description: 'ECS cluster ARN',
      exportName: `ForgeClusterArn-${props.forgeEnv}`,
    });

    for (const [name, queue] of this.sqsQueues.entries()) {
      new cdk.CfnOutput(this, `QueueUrl${name.replace(/-/g, '')}`, {
        value: queue.queueUrl,
        description: `SQS queue URL for ${name}`,
      });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private createTaskDefinition(
    task: SolverTask,
    props: ForgeComputeStackProps,
    executionRole: iam.Role,
    taskRole: iam.Role,
    logGroups: Map<string, logs.LogGroup>,
  ): ecs.Ec2TaskDefinition {
    const td = new ecs.Ec2TaskDefinition(this, `Td${task.name.replace(/-/g, '')}`, {
      networkMode: ecs.NetworkMode.AWS_VPC,
      taskRole,
      executionRole,
      // Bin-packing placement constraints: spread across instances but pack by CPU
      placementConstraints: [],
    });

    // EFS volume mount
    td.addVolume({
      name: 'forge-efs',
      efsVolumeConfiguration: {
        fileSystemId: props.efsFilesystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          iam: 'ENABLED',
        },
      },
    });

    // Build environment variables — inject runtime config
    const envVars: { [key: string]: string } = {
      ...task.environment,
      AWS_REGION: this.region,
      AWS_ACCOUNT_ID: this.account,
      FORGE_ENV: props.forgeEnv,
      S3_BUCKET: props.dataBucket.bucketName,
      DYNAMODB_TABLE: props.jobsTable.tableName,
      ECS_CLUSTER: this.ecsCluster.clusterName,
    };

    if (props.rdsEndpoint) {
      envVars['DB_HOST'] = props.rdsEndpoint;
      envVars['DB_PORT'] = '5432';
    }

    // Add SQS queue URL for scale-to-zero tasks
    if (task.scalingMode === 'sqs-driven' && task.sqsQueueName) {
      const queue = this.sqsQueues.get(task.name);
      if (queue) {
        envVars['SQS_QUEUE_URL'] = queue.queueUrl;
      }
    }

    // ECR image reference
    const repo = props.ecrRepos.get(task.name);
    const imageUri = repo
      ? ecs.ContainerImage.fromEcrRepository(repo, 'latest')
      : ecs.ContainerImage.fromRegistry(`${this.account}.dkr.ecr.${this.region}.amazonaws.com/${task.name}:latest`);

    const logGroup = logGroups.get(task.name);

    // Main container
    const container = td.addContainer(`${task.name}-container`, {
      image: imageUri,
      cpu: task.cpu,
      memoryLimitMiB: task.memory,
      essential: task.essential,
      environment: envVars,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: task.name,
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:${task.port}${task.healthCheckPath} || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60), // Allow startup time
      },
      portMappings: [
        {
          containerPort: task.port,
          hostPort: task.port,
          protocol: ecs.Protocol.TCP,
        },
      ],
      stopTimeout: cdk.Duration.seconds(120), // Graceful shutdown time for HPC jobs
      linuxParameters: new ecs.LinuxParameters(this, `LinuxParams${task.name.replace(/-/g, '')}`, {
        initProcessEnabled: true, // Proper PID 1 for supervisord-based containers
      }),
    });

    // Mount EFS volume (first EFS mount in task's volume list)
    const efsMount = task.volumes.find(v => v.type === 'efs');
    if (efsMount) {
      container.addMountPoints({
        containerPath: efsMount.containerPath,
        sourceVolume: 'forge-efs',
        readOnly: efsMount.readOnly ?? false,
      });
    }

    return td;
  }

  private createAlwaysOnService(
    task: SolverTask,
    props: ForgeComputeStackProps,
    dnsNamespace: servicediscovery.PrivateDnsNamespace,
    capacityProvider: ecs.AsgCapacityProvider,
  ): ecs.Ec2Service {
    const td = this.taskDefinitions.get(task.name)!;

    const service = new ecs.Ec2Service(this, `Svc${task.name.replace(/-/g, '')}`, {
      cluster: this.ecsCluster,
      taskDefinition: td,
      desiredCount: 1,
      minHealthyPercent: 0, // Allow rolling deploy on single instance
      maxHealthyPercent: 200,
      enableExecuteCommand: true, // SSM exec for debugging
      circuitBreaker: { rollback: true },
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
      capacityProviderStrategies: [
        { capacityProvider: capacityProvider.capacityProviderName, weight: 1, base: 1 },
      ],
      // Bin-packing: place tasks to minimize number of instances
      placementStrategies: [
        ecs.PlacementStrategy.packedByCpu(),
        ecs.PlacementStrategy.packedByMemory(),
      ],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSecurityGroup],
      // Cloud Map for service discovery
      cloudMapOptions: {
        name: task.name,
        cloudMapNamespace: dnsNamespace,
        dnsRecordType: servicediscovery.DnsRecordType.SRV,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    return service;
  }
}
