/**
 * ForgeTestingHarnessStack -- Tier-2 OMNI Shape-Chip Validation Harness
 *
 * Scope (explicit):
 *   - Tier-2 ONLY: drive the 313 OMNI shape-chip JSONs from vpneoterra/forgenew
 *     through the OMNI tessellation endpoint (`/api/sdf/render`) and record
 *     per-chip pass/fail.
 *   - Deployed conditionally behind `-c deployTestingHarness=true` AND
 *     requires `-c deployOmni=true` (OMNI stack must exist to target).
 *
 * Out of scope (DO NOT extend this stack to cover):
 *   - Tier-3 classifier eval, param sweep
 *   - Any Anthropic / Voyage secrets
 *   - Any mutation of OMNI or app stacks
 *
 * Cost ceiling:
 *   - USD 50 AWS Budget scoped to tag CostCenter=forge-testing-harness
 *   - SNS alarm topic for budget breaches
 *   - Pause is executed by scripts/harness-pause.sh (operator-run), wired
 *     to the SNS topic so operators receive the signal and can run the
 *     script out-of-band. (We do not auto-kill infra from a Lambda inside
 *     this stack -- budgets are lagging, and silent infra termination is
 *     surprising. The operator playbook lives in the script header.)
 *
 * Resources created:
 *   - ECR repo `forge-testing-harness` for the runner image
 *   - CloudWatch log group `/forge/ecs/testing-harness`
 *   - Fargate task definition with desiredCount=0 service (manual launch)
 *   - AWS Budget (USD 50) scoped to CostCenter tag
 *   - SNS topic `forge-harness-alerts` for budget notifications
 *
 * Incremental monthly cost when idle:
 *   - ECR repo storage: < $0.10
 *   - CloudWatch log group (7-day retention): < $0.05
 *   - SNS topic: $0 until it fires
 *   - Fargate service (desiredCount=0): $0
 *   Total: ~$0.15/month idle. Running 313-part batch costs a few cents of
 *   Fargate time, well under the USD 50 ceiling.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import {
  HARNESS_RUNNER,
  HARNESS_COST_CEILING_USD,
  HARNESS_BUDGET_THRESHOLDS_PERCENT,
  HARNESS_COST_CENTER_TAG,
  SHAPE_CHIP_EXPECTED_COUNT,
} from './config/testing-harness-manifest';

export interface ForgeTestingHarnessStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  /**
   * OMNI ALB DNS name (e.g. `omni.qrucible.ai`). The runner POSTs to
   * https://<omniAlbHost><HARNESS_RUNNER.omniRenderPath>. Passed in as a
   * property so we do not cross-import the OMNI stack's construct.
   */
  omniAlbHost: string;
  /** Email for harness budget alerts */
  alertEmail: string;
  tags?: Record<string, string>;
}

export class ForgeTestingHarnessStack extends cdk.Stack {
  public readonly runnerRepo: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ForgeTestingHarnessStackProps) {
    super(scope, id, props);

    const env = props.forgeEnv;

    // Apply harness-specific cost-center tag to every resource in this stack so
    // the USD 50 Budget can scope cleanly to this harness alone.
    cdk.Tags.of(this).add(HARNESS_COST_CENTER_TAG.key, HARNESS_COST_CENTER_TAG.value);

    // ── ECR repository for the runner image ────────────────────────────────
    this.runnerRepo = new ecr.Repository(this, 'HarnessRunnerRepo', {
      repositoryName: HARNESS_RUNNER.ecrRepo,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: 'Retain only the last 5 runner images',
          maxImageCount: 5,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ECS cluster (Fargate-only, dedicated) ─────────────────────────────
    this.cluster = new ecs.Cluster(this, 'HarnessCluster', {
      clusterName: `forge-testing-harness-${env}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false,
    });

    // ── CloudWatch log group ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'HarnessLogs', {
      logGroupName: '/forge/ecs/testing-harness',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM roles ─────────────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'HarnessExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    this.runnerRepo.grantPull(executionRole);

    const taskRole = new iam.Role(this, 'HarnessTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // ── Fargate task definition ───────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'HarnessTaskDef', {
      family: 'forge-testing-harness',
      cpu: HARNESS_RUNNER.cpu,
      memoryLimitMiB: HARNESS_RUNNER.memory,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDef.addContainer('harness-runner', {
      image: ecs.ContainerImage.fromEcrRepository(this.runnerRepo, 'latest'),
      essential: true,
      environment: {
        // Authoritative OMNI endpoint. Both path and host are overridable so
        // the harness can be repointed without a redeploy if OMNI moves.
        OMNI_BASE_URL: `https://${props.omniAlbHost}`,
        OMNI_RENDER_PATH: HARNESS_RUNNER.omniRenderPath,
        OMNI_HEALTH_PATH: HARNESS_RUNNER.omniHealthPath,
        PER_PART_TIMEOUT_SEC: String(HARNESS_RUNNER.perPartTimeoutSec),
        DEFAULT_VOXEL_SIZE_MM: String(HARNESS_RUNNER.defaultVoxelSizeMm),
        EXPECTED_SHAPE_CHIP_COUNT: String(SHAPE_CHIP_EXPECTED_COUNT),
        MAX_PARTS_PER_RUN: String(HARNESS_RUNNER.maxPartsPerRun),
        FORGE_ENV: env,
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'harness',
      }),
    });

    // ── Fargate service (desiredCount=0 -- manual launch only) ────────────
    // Operator runs scripts/harness-run.sh to run a one-shot task; the
    // service itself never stays up. We still declare a service (rather than
    // just a task def) so operators can inspect `aws ecs describe-services`
    // and find the harness alongside the other FORGE services.
    this.service = new ecs.FargateService(this, 'HarnessService', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      serviceName: `forge-testing-harness-${env}`,
      desiredCount: 0,
      enableExecuteCommand: true,
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 },
      ],
    });

    // ── SNS topic for budget / alarm notifications ────────────────────────
    this.alertTopic = new sns.Topic(this, 'HarnessAlerts', {
      topicName: 'forge-harness-alerts',
      displayName: 'FORGE Tier-2 Testing Harness Alerts',
    });
    this.alertTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(props.alertEmail),
    );

    // ── AWS Budget (USD 50) scoped to harness tag ─────────────────────────
    // Budgets cost-filter uses the `TagKeyValue` format: "user:KEY$VALUE".
    const costFilterTag = `user:${HARNESS_COST_CENTER_TAG.key}$${HARNESS_COST_CENTER_TAG.value}`;
    new budgets.CfnBudget(this, 'HarnessBudget', {
      budget: {
        budgetName: `forge-testing-harness-${env}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: HARNESS_COST_CEILING_USD,
          unit: 'USD',
        },
        costFilters: {
          TagKeyValue: [costFilterTag],
        },
      },
      notificationsWithSubscribers: HARNESS_BUDGET_THRESHOLDS_PERCENT.map(
        (pct) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: pct,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'SNS',
              address: this.alertTopic.topicArn,
            },
            {
              subscriptionType: 'EMAIL',
              address: props.alertEmail,
            },
          ],
        }),
      ),
    });

    // SNS topic policy so AWS Budgets can publish to it.
    this.alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsToPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alertTopic.topicArn],
    }));

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'HarnessEcrUri', {
      value: this.runnerRepo.repositoryUri,
      description: 'ECR repository URI for the harness runner image',
      exportName: `ForgeTestingHarnessEcr-${env}`,
    });

    new cdk.CfnOutput(this, 'HarnessClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name for the harness',
      exportName: `ForgeTestingHarnessCluster-${env}`,
    });

    new cdk.CfnOutput(this, 'HarnessTaskDefArn', {
      value: taskDef.taskDefinitionArn,
      description: 'ECS task definition ARN (use with run-task for one-shot runs)',
      exportName: `ForgeTestingHarnessTaskDef-${env}`,
    });

    new cdk.CfnOutput(this, 'HarnessAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for harness budget / pause alerts',
      exportName: `ForgeTestingHarnessAlertTopic-${env}`,
    });

    new cdk.CfnOutput(this, 'HarnessCostCeilingUsd', {
      value: String(HARNESS_COST_CEILING_USD),
      description: 'Monthly USD cost ceiling enforced by the harness budget',
    });

    new cdk.CfnOutput(this, 'HarnessOmniTarget', {
      value: `https://${props.omniAlbHost}${HARNESS_RUNNER.omniRenderPath}`,
      description: 'OMNI endpoint the harness will POST chips to',
    });
  }
}
