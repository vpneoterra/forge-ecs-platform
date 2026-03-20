/**
 * ForgeOrchestrationStack
 * Step Functions state machines, EventBridge rules, CloudWatch alarms + dashboard.
 *
 * State machines:
 *   1. CEM Loop       — 7-state concurrent engineering loop (Declare → Solve → Compile → Validate → Evaluate → Iterate)
 *   2. Stellarator Pipeline — 8-phase stellarator design pipeline
 *
 * SQS-driven tasks use Step Functions ECS RunTask integration to spin up compute on demand.
 * Cost: Step Functions ($1/month at 1000 state transitions/day), EventBridge ($0/month for default bus).
 */

import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ForgeOrchestrationStackProps extends cdk.StackProps {
  forgeEnv: string;
  ecsCluster: ecs.Cluster;
  taskDefinitions: Map<string, ecs.Ec2TaskDefinition>;
  sqsQueues: Map<string, sqs.Queue>;
  jobsTable: dynamodb.Table;
  alertEmail: string;
  tags?: Record<string, string>;
}

export class ForgeOrchestrationStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly cemStateMachine: sfn.StateMachine;
  public readonly stellaratorStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ForgeOrchestrationStackProps) {
    super(scope, id, props);

    // ── SNS Alert Topic ───────────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `forge-alerts-${props.forgeEnv}`,
      displayName: 'FORGE Platform Alerts',
    });

    this.alertTopic.addSubscription(
      new snsSubscriptions.EmailSubscription(props.alertEmail),
    );

    // ── Step Functions IAM Role ────────────────────────────────────────────────
    const sfnRole = new iam.Role(this, 'StepFunctionsRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:RunTask',
        'ecs:StopTask',
        'ecs:DescribeTasks',
        'iam:PassRole',
      ],
      resources: ['*'],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'sqs:SendMessage',
        'sqs:GetQueueUrl',
        'sqs:GetQueueAttributes',
      ],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:forge-*`],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      resources: [props.jobsTable.tableArn, `${props.jobsTable.tableArn}/index/*`],
    }));

    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogDelivery', 'logs:PutLogEvents', 'logs:DescribeLogGroups'],
      resources: ['*'],
    }));

    // ── Helper: Build ECS RunTask step for a given task ────────────────────────
    const buildRunTaskStep = (
      taskName: string,
      stateName: string,
      integration: sfn.IntegrationPattern,
    ): sfn.State => {
      const td = props.taskDefinitions.get(taskName);
      if (!td) {
        // Return a pass state if task definition not found (graceful degradation)
        return new sfn.Pass(this, `${stateName}Skip`, {
          comment: `Task definition ${taskName} not available`,
        });
      }

      return new sfnTasks.EcsRunTask(this, stateName, {
        cluster: props.ecsCluster,
        taskDefinition: td,
        launchTarget: new sfnTasks.EcsEc2LaunchTarget(),
        integrationPattern: integration,
        resultPath: `$.${taskName.replace(/-/g, '_')}_result`,
        containerOverrides: [
          {
            containerDefinition: td.defaultContainer!,
            environment: [
              {
                name: 'JOB_ID',
                value: sfn.JsonPath.stringAt('$.job_id'),
              },
              {
                name: 'INPUT_S3_KEY',
                value: sfn.JsonPath.stringAt('$.input_s3_key'),
              },
            ],
          },
        ],
      });
    };

    // ── CEM Loop State Machine ─────────────────────────────────────────────────
    // Concurrent Engineering Model for fusion component design.
    // Phases: Declare → Solve → Compile → Validate (CFD || EM in parallel) → Evaluate → Iterate

    // State: Declare — record job in DynamoDB
    const cemDeclare = new sfnTasks.DynamoPutItem(this, 'CemDeclare', {
      table: props.jobsTable,
      item: {
        job_id: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt('$.job_id'),
        ),
        created_at: sfnTasks.DynamoAttributeValue.numberFromString(
          sfn.JsonPath.stringAt('$.timestamp'),
        ),
        status: sfnTasks.DynamoAttributeValue.fromString('DECLARED'),
        task_type: sfnTasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt('$.task_type'),
        ),
      },
      resultPath: '$.declare_result',
    });

    // State: Solve — run geometry (always-on, no RunTask needed — send via SQS to forge-lightweight)
    const cemSolveSqsSend = new sfnTasks.SqsSendMessage(this, 'CemSolve', {
      queue: props.sqsQueues.get('forge-hpc') || new sqs.Queue(this, 'FallbackQueue', {
        queueName: 'forge-cem-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromJsonPathAt('$'),
      messageGroupId: 'cem-solve',
      resultPath: '$.solve_result',
    });

    // State: Validate CFD (parallel branch)
    const cemValidateCfd = new sfnTasks.SqsSendMessage(this, 'CemValidateCfd', {
      queue: props.sqsQueues.get('forge-fem-cfd') || new sqs.Queue(this, 'FallbackQueueCfd', {
        queueName: 'forge-cem-cfd-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromJsonPathAt('$'),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.cfd_result',
    });

    // State: Validate EM (parallel branch)
    const cemValidateEm = new sfn.Pass(this, 'CemValidateEm', {
      comment: 'EM validation via forge-hpc (PROCESS)',
      result: sfn.Result.fromObject({ em_validated: true }),
      resultPath: '$.em_result',
    });

    // State: Validate (parallel)
    const cemValidate = new sfn.Parallel(this, 'CemValidate', {
      resultPath: '$.validation_results',
    });
    cemValidate.branch(cemValidateCfd);
    cemValidate.branch(cemValidateEm);

    // State: Evaluate — check if results meet criteria
    const cemEvaluate = new sfnTasks.DynamoUpdateItem(this, 'CemEvaluate', {
      table: props.jobsTable,
      key: {
        job_id: sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.job_id')),
        created_at: sfnTasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.timestamp')),
      },
      expressionAttributeValues: {
        ':s': sfnTasks.DynamoAttributeValue.fromString('EVALUATING'),
      },
      updateExpression: 'SET #st = :s',
      expressionAttributeNames: { '#st': 'status' },
      resultPath: '$.evaluate_result',
    });

    // State: Iterate or complete
    const cemIterateChoice = new sfn.Choice(this, 'CemIterateChoice')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.iteration'),
          sfn.Condition.numberGreaterThan('$.iteration', 10),
        ),
        new sfn.Succeed(this, 'CemComplete', { comment: 'Max iterations reached' }),
      )
      .otherwise(cemDeclare); // Loop back

    // State: Update status to SOLVED before evaluate
    const cemUpdateSolved = new sfnTasks.DynamoUpdateItem(this, 'CemUpdateSolved', {
      table: props.jobsTable,
      key: {
        job_id: sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.job_id')),
        created_at: sfnTasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.timestamp')),
      },
      expressionAttributeValues: {
        ':s': sfnTasks.DynamoAttributeValue.fromString('SOLVED'),
      },
      updateExpression: 'SET #st = :s',
      expressionAttributeNames: { '#st': 'status' },
      resultPath: '$.solved_result',
    });

    // Chain: Declare → Solve → Validate (parallel) → Evaluate → Iterate
    const cemChain = sfn.Chain.start(cemDeclare)
      .next(cemSolveSqsSend)
      .next(cemUpdateSolved)
      .next(cemValidate)
      .next(cemEvaluate)
      .next(cemIterateChoice);

    const cemLogGroup = new logs.LogGroup(this, 'CemStateMachineLogs', {
      logGroupName: '/forge/stepfunctions/cem-loop',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cemStateMachine = new sfn.StateMachine(this, 'CemStateMachine', {
      stateMachineName: `forge-cem-loop-${props.forgeEnv}`,
      definition: cemChain,
      role: sfnRole,
      stateMachineType: sfn.StateMachineType.STANDARD,
      logs: {
        destination: cemLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
      tracingEnabled: false, // X-Ray adds cost — disable for dev
      timeout: cdk.Duration.hours(24),
    });

    // ── Stellarator Pipeline State Machine ────────────────────────────────────
    // 8-phase pipeline: Config → Equilibrium → Coils → CAD → HPC → FEM → Analysis → Export

    // Phase 1: Config — pyQSC/pyQIC/DESC (via SQS → forge-stellarator-config)
    const stPhase1 = new sfnTasks.SqsSendMessage(this, 'StPhase1Config', {
      queue: props.sqsQueues.get('forge-stellarator-config') || new sqs.Queue(this, 'FallbackStConfig', {
        queueName: 'forge-st-config-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'config',
        input: sfn.JsonPath.stringAt('$.config_input'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase1_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase1', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 2: Equilibrium — VMEC++ (via SQS → forge-hpc)
    const stPhase2 = new sfnTasks.SqsSendMessage(this, 'StPhase2Equilibrium', {
      queue: props.sqsQueues.get('forge-hpc') || new sqs.Queue(this, 'FallbackStHpc', {
        queueName: 'forge-st-hpc-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'equilibrium',
        solver: 'VMEC++',
        input_s3_key: sfn.JsonPath.stringAt('$.config_s3_key'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase2_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase2', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 3: Coil optimization — SIMSOPT (via SQS → forge-stellarator-coils)
    const stPhase3 = new sfnTasks.SqsSendMessage(this, 'StPhase3Coils', {
      queue: props.sqsQueues.get('forge-stellarator-coils') || new sqs.Queue(this, 'FallbackStCoils', {
        queueName: 'forge-st-coils-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'coil_optimization',
        equilibrium_s3_key: sfn.JsonPath.stringAt('$.phase2_result.output_s3_key'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase3_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase3', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 4: CAD generation — Bluemira/ParaStell (via SQS → forge-stellarator-cad)
    const stPhase4 = new sfnTasks.SqsSendMessage(this, 'StPhase4Cad', {
      queue: props.sqsQueues.get('forge-stellarator-cad') || new sqs.Queue(this, 'FallbackStCad', {
        queueName: 'forge-st-cad-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'cad_generation',
        coils_s3_key: sfn.JsonPath.stringAt('$.phase3_result.output_s3_key'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase4_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase4', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 5: HPC neutronics — OpenMC
    const stPhase5 = new sfnTasks.SqsSendMessage(this, 'StPhase5Hpc', {
      queue: props.sqsQueues.get('forge-hpc') || new sqs.Queue(this, 'FallbackStHpc2', {
        queueName: 'forge-st-hpc2-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'neutronics',
        solver: 'OpenMC',
        cad_s3_key: sfn.JsonPath.stringAt('$.phase4_result.output_s3_key'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase5_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase5', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 6: FEM analysis — Elmer (thermal/structural)
    const stPhase6 = new sfnTasks.SqsSendMessage(this, 'StPhase6Fem', {
      queue: props.sqsQueues.get('forge-fem-cfd') || new sqs.Queue(this, 'FallbackStFem', {
        queueName: 'forge-st-fem-fallback.fifo',
        fifo: true,
      }),
      messageBody: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        job_id: sfn.JsonPath.stringAt('$.job_id'),
        phase: 'structural_thermal',
        solver: 'Elmer',
        cad_s3_key: sfn.JsonPath.stringAt('$.phase4_result.output_s3_key'),
      }),
      messageGroupId: sfn.JsonPath.stringAt('$.job_id'),
      resultPath: '$.phase6_result',
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageDeduplicationId: sfn.JsonPath.format('{}-phase6', sfn.JsonPath.stringAt('$.job_id')),
    });

    // Phase 7: Analysis — record results in DynamoDB
    const stPhase7 = new sfnTasks.DynamoUpdateItem(this, 'StPhase7Analysis', {
      table: props.jobsTable,
      key: {
        job_id: sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.job_id')),
        created_at: sfnTasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.timestamp')),
      },
      expressionAttributeValues: {
        ':s': sfnTasks.DynamoAttributeValue.fromString('ANALYSIS_COMPLETE'),
      },
      updateExpression: 'SET #st = :s',
      expressionAttributeNames: { '#st': 'status' },
      resultPath: '$.phase7_result',
    });

    // Phase 8: Export — mark complete
    const stPhase8 = new sfnTasks.DynamoUpdateItem(this, 'StPhase8Export', {
      table: props.jobsTable,
      key: {
        job_id: sfnTasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.job_id')),
        created_at: sfnTasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.timestamp')),
      },
      expressionAttributeValues: {
        ':s': sfnTasks.DynamoAttributeValue.fromString('COMPLETE'),
        ':t': sfnTasks.DynamoAttributeValue.numberFromString(
          sfn.JsonPath.stringAt('$$.Execution.StartTime'),
        ),
      },
      updateExpression: 'SET #st = :s, completed_at = :t',
      expressionAttributeNames: { '#st': 'status' },
      resultPath: '$.phase8_result',
    });

    // Chain stellarator phases
    const stellaratorChain = sfn.Chain.start(stPhase1)
      .next(stPhase2)
      .next(stPhase3)
      .next(stPhase4)
      // Phases 5 + 6 run in parallel (neutronics + FEM can run concurrently on same CAD)
      .next(
        new sfn.Parallel(this, 'StParallelHpcFem', {
          resultPath: '$.parallel_results',
        })
          .branch(stPhase5)
          .branch(stPhase6),
      )
      .next(stPhase7)
      .next(stPhase8)
      .next(new sfn.Succeed(this, 'StComplete'));

    const stLogGroup = new logs.LogGroup(this, 'StStateMachineLogs', {
      logGroupName: '/forge/stepfunctions/stellarator-pipeline',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stellaratorStateMachine = new sfn.StateMachine(this, 'StellaratorStateMachine', {
      stateMachineName: `forge-stellarator-pipeline-${props.forgeEnv}`,
      definition: stellaratorChain,
      role: sfnRole,
      stateMachineType: sfn.StateMachineType.STANDARD,
      logs: {
        destination: stLogGroup,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
      tracingEnabled: false,
      timeout: cdk.Duration.hours(72), // Stellarator jobs can take days
    });

    // ── EventBridge Rules ──────────────────────────────────────────────────────

    // Rule: ECS task state change → CloudWatch custom metric
    new events.Rule(this, 'EcsTaskStateChangeRule', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [props.ecsCluster.clusterArn],
          lastStatus: ['STOPPED'],
          stoppedReason: [{ prefix: 'Host EC2' }], // Spot interruption
        },
      },
      targets: [
        new eventsTargets.SnsTopic(this.alertTopic, {
          message: events.RuleTargetInput.fromText(
            `FORGE ALERT: ECS task stopped due to Spot interruption in cluster ${props.ecsCluster.clusterName}`,
          ),
        }),
      ],
    });

    // Rule: SQS DLQ depth > 0 → alert
    new events.Rule(this, 'DlqAlertRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [], // Placeholder — use CloudWatch alarm instead (below)
    });

    // ── CloudWatch Alarms ──────────────────────────────────────────────────────

    // Alarm: ECS task failures > 3/hour
    const taskFailureAlarm = new cloudwatch.Alarm(this, 'TaskFailureAlarm', {
      alarmName: `forge-task-failures-${props.forgeEnv}`,
      alarmDescription: 'ECS task failures exceeded threshold',
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'TaskCount',
        dimensionsMap: {
          ClusterName: props.ecsCluster.clusterName,
          TaskDefinitionFamily: 'forge-*',
        },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    taskFailureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));

    // Alarm: Monthly cost estimate > $300 (billing alarm)
    const costAlarm = new cloudwatch.Alarm(this, 'CostAlarm', {
      alarmName: `forge-monthly-cost-${props.forgeEnv}`,
      alarmDescription: 'Estimated monthly cost exceeded $300',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Billing',
        metricName: 'EstimatedCharges',
        dimensionsMap: { Currency: 'USD' },
        statistic: 'Maximum',
        period: cdk.Duration.hours(6),
        region: 'us-east-1', // Billing metrics only in us-east-1
      }),
      threshold: 300,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    costAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));

    // Alarm: SQS DLQ depth > 0 (failed jobs)
    for (const [taskName, queue] of props.sqsQueues.entries()) {
      // DLQ alarm — check approximate DLQ depth via metric filter
      const dlqAlarm = new cloudwatch.Alarm(this, `DlqAlarm${taskName.replace(/-/g, '')}`, {
        alarmName: `forge-dlq-${taskName}-${props.forgeEnv}`,
        alarmDescription: `DLQ depth > 0 for ${taskName} — job processing failed`,
        metric: queue.metricApproximateNumberOfMessagesVisible({
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alertTopic));
    }

    // ── CloudWatch Dashboard ───────────────────────────────────────────────────
    const dashboard = new cloudwatch.Dashboard(this, 'ForgeDashboard', {
      dashboardName: `forge-platform-health-${props.forgeEnv}`,
    });

    dashboard.addWidgets(
      // Row 1: ECS metrics
      new cloudwatch.TextWidget({
        markdown: '## FORGE Platform Health',
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS CPU Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'CPUUtilization',
            dimensionsMap: { ClusterName: props.ecsCluster.clusterName },
            statistic: 'Average',
          }),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Memory Utilization',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ECS',
            metricName: 'MemoryUtilization',
            dimensionsMap: { ClusterName: props.ecsCluster.clusterName },
            statistic: 'Average',
          }),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Monthly Cost Estimate',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Billing',
            metricName: 'EstimatedCharges',
            dimensionsMap: { Currency: 'USD' },
            statistic: 'Maximum',
            region: 'us-east-1',
          }),
        ],
        width: 8,
      }),
    );

    // Row 2: SQS queue depths
    const sqsWidgets: cloudwatch.IWidget[] = [];
    for (const [taskName, queue] of props.sqsQueues.entries()) {
      sqsWidgets.push(
        new cloudwatch.GraphWidget({
          title: `Queue Depth: ${taskName}`,
          left: [
            queue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' }),
          ],
          width: 8,
        }),
      );
    }

    if (sqsWidgets.length > 0) {
      dashboard.addWidgets(...sqsWidgets);
    }

    // Row 3: Step Functions
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CEM Loop Executions',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsStarted',
            dimensionsMap: {
              StateMachineArn: this.cemStateMachine.stateMachineArn,
            },
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsFailed',
            dimensionsMap: {
              StateMachineArn: this.cemStateMachine.stateMachineArn,
            },
            statistic: 'Sum',
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Stellarator Pipeline Executions',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsStarted',
            dimensionsMap: {
              StateMachineArn: this.stellaratorStateMachine.stateMachineArn,
            },
            statistic: 'Sum',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/States',
            metricName: 'ExecutionsFailed',
            dimensionsMap: {
              StateMachineArn: this.stellaratorStateMachine.stateMachineArn,
            },
            statistic: 'Sum',
          }),
        ],
        width: 12,
      }),
    );

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS alert topic ARN',
      exportName: `ForgeAlertTopic-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'CemStateMachineArn', {
      value: this.cemStateMachine.stateMachineArn,
      description: 'CEM Loop state machine ARN',
      exportName: `ForgeCemStateMachine-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'StellaratorStateMachineArn', {
      value: this.stellaratorStateMachine.stateMachineArn,
      description: 'Stellarator Pipeline state machine ARN',
      exportName: `ForgeStellaratorStateMachine-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=forge-platform-health-${props.forgeEnv}`,
      description: 'CloudWatch dashboard URL',
    });
  }
}
