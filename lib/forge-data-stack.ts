/**
 * ForgeDataStack
 * Persistent data layer: S3 (Intelligent-Tiering), EFS (bursting), RDS (t4g.micro optional),
 * ECR (8 repos), DynamoDB (pay-per-request — free tier covers most usage).
 *
 * Key cost decisions:
 * - S3 Intelligent-Tiering: auto-moves cold data to cheaper tiers
 * - EFS bursting (0 provisioned throughput): $0.30/GB-month
 * - RDS t4g.micro: $12/month — skipRds=true to use external Supabase ($0)
 * - DynamoDB pay-per-request: free tier = 25 GB, 25 WCU, 25 RCU
 * - ECR 8 repos: ~$2/month for 20 GB storage
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { SOLVER_MANIFEST } from './config/solver-manifest';

export interface ForgeDataStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
  efsSecurityGroup: ec2.SecurityGroup;
  /** Set true to skip RDS — use external Supabase instead */
  skipRds: boolean;
  tags?: Record<string, string>;
}

export class ForgeDataStack extends cdk.Stack {
  public readonly dataBucket: s3.Bucket;
  public readonly efsFilesystem: efs.FileSystem;
  public readonly ecrRepos: Map<string, ecr.Repository>;
  public readonly jobsTable: dynamodb.Table;
  /** RDS endpoint or empty string if skipRds=true */
  public readonly rdsEndpoint: string;

  constructor(scope: Construct, id: string, props: ForgeDataStackProps) {
    super(scope, id, props);

    const isProd = props.forgeEnv === 'prod';

    // ── S3: forge-platform-data ───────────────────────────────────────────────
    // Intelligent-Tiering transitions cold data automatically — no lifecycle rule complexity.
    // First 128 KB of each object stays in frequent access tier always.
    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `forge-platform-data-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      intelligentTieringConfigurations: [
        {
          name: 'ForgeITConfig',
          archiveAccessTierTime: cdk.Duration.days(90),
          deepArchiveAccessTierTime: cdk.Duration.days(180),
        },
      ],
      lifecycleRules: [
        {
          // Delete incomplete multipart uploads (prevents orphaned storage charges)
          id: 'AbortIncompleteMultipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          // Delete non-current versions after 30 days (versioning cleanup)
          id: 'ExpireOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
          noncurrentVersionsToRetain: 3,
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'], // Restrict in prod
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    // ── EFS: shared workspace filesystem ─────────────────────────────────────
    // Bursting throughput (no provisioned throughput cost).
    // Single-AZ for dev (saves ~50% on storage), multi-AZ for prod.
    this.efsFilesystem = new efs.FileSystem(this, 'ForgeEfs', {
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        // Single subnet for dev — avoid cross-AZ EFS mount target charges
        availabilityZones: isProd ? undefined : [props.vpc.availabilityZones[0]],
      },
      securityGroup: props.efsSecurityGroup,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      enableAutomaticBackups: isProd,
    });

    // EFS Access Points — one per service group for isolation
    const efsAccessPoints: Record<string, efs.AccessPoint> = {};
    const efsPaths = [
      '/geometry',
      '/forgejo',
      '/minio',
      '/prometheus',
      '/grafana',
      '/stellarator-config',
      '/hpc',
      '/fem-cfd',
      '/stellarator-coils',
      '/stellarator-cad',
    ];

    for (const path of efsPaths) {
      const apId = path.replace(/^\//, '').replace(/-/g, '').replace('/', '');
      efsAccessPoints[path] = new efs.AccessPoint(this, `EfsAp${apId}`, {
        fileSystem: this.efsFilesystem,
        path,
        createAcl: { ownerGid: '1000', ownerUid: '1000', permissions: '750' },
        posixUser: { gid: '1000', uid: '1000' },
      });
    }

    // ── DynamoDB: forge-jobs ──────────────────────────────────────────────────
    // Pay-per-request = free tier covers 1-2 person team usage easily.
    // No Redis needed — use DynamoDB for job state and simple caching.
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: 'forge-jobs',
      partitionKey: { name: 'job_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: isProd,
      timeToLiveAttribute: 'ttl',
    });

    // GSI: query by status + creation time
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: query by task type + status (useful for queue monitoring)
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'task-status-index',
      partitionKey: { name: 'task_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['job_id', 'created_at', 'updated_at', 'result_s3_key'],
    });

    // ── ECR Repositories — one per consolidated task ──────────────────────────
    this.ecrRepos = new Map<string, ecr.Repository>();

    for (const task of SOLVER_MANIFEST) {
      const repo = new ecr.Repository(this, `EcrRepo${task.name.replace(/-/g, '')}`, {
        repositoryName: task.name,
        encryption: ecr.RepositoryEncryption.AES_256,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            // Remove untagged images after 7 days
            rulePriority: 1,
            description: 'Remove untagged after 7 days',
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(7),
          },
          {
            // Keep only last 5 images — controls ECR storage cost
            rulePriority: 2,
            description: 'Keep last 5 images',
            maxImageCount: 5,
            // TagStatus.ANY must have the highest rulePriority
          },
        ],
      });
      this.ecrRepos.set(task.name, repo);
    }

    // ── RDS PostgreSQL (optional) ─────────────────────────────────────────────
    // t4g.micro: cheapest RDS instance — $12/month.
    // Shared by forge-devops (Forgejo + SysON) with separate databases.
    // skipRds=true: use external Supabase (free tier) — saves $12/month.
    if (!props.skipRds) {
      const dbSubnetGroup = new rds.SubnetGroup(this, 'DbSubnetGroup', {
        vpc: props.vpc,
        description: 'FORGE RDS subnet group',
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const dbInstance = new rds.DatabaseInstance(this, 'ForgeRds', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        }),
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.dbSecurityGroup],
        subnetGroup: dbSubnetGroup,
        allocatedStorage: 20,
        storageType: rds.StorageType.GP3,
        storageEncrypted: true,
        multiAz: isProd,
        databaseName: 'forge_main',
        credentials: rds.Credentials.fromGeneratedSecret('forge_admin', {
          secretName: 'forge/rds/master',
        }),
        backupRetention: isProd ? cdk.Duration.days(7) : cdk.Duration.days(1),
        deletionProtection: isProd,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        // Auto-stop after 7 days idle (dev only) — saves ~$8/month
        // Note: RDS auto-stop only applies to RDS instances in "dev" mode.
        // For prod, use manual stop/start via scripts/hibernate.sh
        enablePerformanceInsights: false, // Saves $0/month on t4g.micro (not available)
        monitoringInterval: cdk.Duration.seconds(0), // Disable Enhanced Monitoring (costs extra)
        cloudwatchLogsRetention: 7,
        cloudwatchLogsExports: ['postgresql'],
        parameterGroup: new rds.ParameterGroup(this, 'RdsParamGroup', {
          engine: rds.DatabaseInstanceEngine.postgres({
            version: rds.PostgresEngineVersion.VER_16,
          }),
          parameters: {
            'shared_buffers': '128MB',
            'max_connections': '50', // t4g.micro has 1GB RAM — keep connections low
            'log_statement': 'none', // Reduce logging cost
            'log_min_duration_statement': '5000', // Only log queries >5s
          },
        }),
      });

      // Expose RDS endpoint for compute stack
      // Use string escape to avoid circular ref — ComputeStack reads from CfnOutput
      new cdk.CfnOutput(this, 'RdsEndpoint', {
        value: dbInstance.dbInstanceEndpointAddress,
        description: 'RDS PostgreSQL endpoint',
        exportName: `ForgeRdsEndpoint-${props.forgeEnv}`,
      });

      new cdk.CfnOutput(this, 'RdsPort', {
        value: dbInstance.dbInstanceEndpointPort,
        description: 'RDS PostgreSQL port',
        exportName: `ForgeRdsPort-${props.forgeEnv}`,
      });

      // Property for compute stack to read
      (this as any)._rdsEndpoint = dbInstance.dbInstanceEndpointAddress;
    }

    // Expose rdsEndpoint as string for compute stack
    // If skipRds, empty string — compute stack checks for this
    this.rdsEndpoint = props.skipRds
      ? ''
      : cdk.Fn.importValue(`ForgeRdsEndpoint-${props.forgeEnv}`);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DataBucketName', {
      value: this.dataBucket.bucketName,
      description: 'S3 data bucket name',
      exportName: `ForgeDataBucket-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'EfsFilesystemId', {
      value: this.efsFilesystem.fileSystemId,
      description: 'EFS filesystem ID',
      exportName: `ForgeEfsId-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'JobsTableName', {
      value: this.jobsTable.tableName,
      description: 'DynamoDB jobs table name',
      exportName: `ForgeJobsTable-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'EcrRepoNames', {
      value: Array.from(this.ecrRepos.keys()).join(','),
      description: 'ECR repository names (comma-separated)',
    });

    new cdk.CfnOutput(this, 'SkipRds', {
      value: props.skipRds ? 'true' : 'false',
      description: 'Whether RDS was skipped (using external Supabase)',
    });
  }
}
