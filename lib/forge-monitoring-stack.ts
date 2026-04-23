/**
 * ForgeMonitoringStack -- FORGE Observability Infrastructure
 *
 * Centralised monitoring constructs that attach to the ForgeAppStack:
 *   - SNS alert topic (email subscriptions)
 *   - CloudWatch 5xx alarm on the ALB
 *   - EventBridge ECS task-state-change rule → Lambda → SNS
 *
 * ALB Access Logs S3 bucket lives in ForgeAppStack (which owns the ALB)
 * because CDK's ALB.logAccessLogs() must be called on the construct that
 * created the resource. See ForgeAppStack for that bucket and the
 * `this.alb.logAccessLogs(...)` call.
 *
 * Cross-stack references:
 *   - props.alb               → ALB construct from ForgeAppStack
 *   - props.ecsCluster        → ECS cluster construct from ForgeAppStack
 *   - props.ecsServiceName    → string service name ('forge-app-test')
 */

import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

export interface ForgeMonitoringStackProps extends cdk.StackProps {
  forgeEnv: string;
  /** Concrete ALB construct from ForgeAppStack (needed for loadBalancerFullName). */
  alb: elbv2.ApplicationLoadBalancer;
  ecsCluster: ecs.ICluster;
  ecsServiceName: string;
  /**
   * Deprecated: retained so callers pass-through without TS errors, but no
   * longer used -- SNS subscriptions on forge-deploy-alerts are managed
   * out-of-band via `aws sns subscribe` rather than through this stack.
   */
  alertEmail: string;
  /** @deprecated see alertEmail */
  alertEmail2?: string;
  tags?: Record<string, string>;
}

export class ForgeMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ForgeMonitoringStackProps) {
    super(scope, id, props);

    // ── A. SNS Alert Topic ────────────────────────────────────────────────────
    // The topic is provisioned out-of-band (pre-existing from an earlier
    // deploy that rolled back) and is imported here by ARN so CDK does not
    // try to create it (which would fail with AlreadyExists) and does not
    // mutate existing confirmed email subscriptions. Alarm actions point at
    // the imported ARN just like they would a managed topic.
    //
    // Subscriptions are assumed to already be present on the topic; they are
    // managed out-of-band via `aws sns subscribe` (see README). If you need
    // to add a new subscription, do it via the CLI or console rather than
    // via CDK, or flip this back to `new sns.Topic(...)` once the out-of-band
    // topic is retired.
    const alertTopic = sns.Topic.fromTopicArn(
      this,
      'ForgeDeployAlerts',
      `arn:aws:sns:${this.region}:${this.account}:forge-deploy-alerts`,
    );

    // ── B. CloudWatch 5xx Alarm ───────────────────────────────────────────────
    // Fires when >10 HTTP 5xx responses are returned from targets in 2
    // consecutive 60-second windows. The ALB full name is the dimension value
    // needed to scope the metric to this specific load balancer.
    const fivexxMetric = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: {
        LoadBalancer: props.alb.loadBalancerFullName,
      },
      statistic: 'Sum',
      period: cdk.Duration.seconds(60),
    });

    const fivexxAlarm = new cloudwatch.Alarm(this, 'Forge5xxAlarm', {
      alarmName: 'forge-app-5xx-rate',
      alarmDescription: 'FORGE ALB: >10 HTTP 5xx responses in a 60-second window (2 consecutive)',
      metric: fivexxMetric,
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,    // Both periods must breach (consecutive)
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    fivexxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // ── C. EventBridge ECS Task State Change → Lambda → SNS ──────────────────
    // Lambda handler: alerts on unexpected task stops (OOM kills, crashes, etc.)
    const ecsAlertLambda = new lambda.Function(this, 'EcsStateAlertFn', {
      functionName: `forge-ecs-state-alert-${props.forgeEnv}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const sns = new SNSClient();
exports.handler = async (event) => {
  const detail = event.detail;
  const status = detail.lastStatus;
  const desiredStatus = detail.desiredStatus;
  // Only alert on: STOPPED (unexpected), OOM kills, unhealthy
  if (status === 'STOPPED' && desiredStatus !== 'STOPPED') {
    const reason = detail.stoppedReason || 'Unknown';
    const taskArn = detail.taskArn;
    const group = detail.group || '';
    const container = (detail.containers || []).map(c => \`\${c.name}:\${c.exitCode}\`).join(', ');
    await sns.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: \`⚠ FORGE ECS: Task stopped unexpectedly\`,
      Message: [
        \`Task: \${taskArn}\`,
        \`Group: \${group}\`,
        \`Status: \${status} (desired: \${desiredStatus})\`,
        \`Reason: \${reason}\`,
        \`Containers: \${container}\`,
        \`Time: \${new Date().toISOString()}\`,
      ].join('\\n'),
    }));
  }
};
`),
      environment: {
        SNS_TOPIC_ARN: alertTopic.topicArn,
      },
      timeout: cdk.Duration.seconds(10),
    });

    // Allow Lambda to publish to the SNS topic
    alertTopic.grantPublish(ecsAlertLambda);

    // CloudWatch Log Group for the Lambda (3-day retention)
    new logs.LogGroup(this, 'EcsAlertLambdaLogGroup', {
      logGroupName: `/aws/lambda/forge-ecs-state-alert-${props.forgeEnv}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── D. EventBridge Rule: ECS Task State Change ────────────────────────────
    // Matches task state change events for this specific cluster.
    // The clusterArn detail field contains the full ARN; we filter by matching
    // the cluster ARN prefix so this rule only fires for our cluster.
    const ecsStateRule = new events.Rule(this, 'EcsStateChangeRule', {
      ruleName: 'forge-ecs-state-change',
      description: 'Route FORGE ECS task state changes to alert Lambda',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [props.ecsCluster.clusterArn],
        },
      },
    });

    ecsStateRule.addTarget(new eventsTargets.LambdaFunction(ecsAlertLambda, {
      retryAttempts: 2,
    }));

    // ── E. CloudFormation Outputs ─────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS alert topic ARN (forge-deploy-alerts)',
      exportName: `ForgeAlertTopicArn-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'EventBridgeRuleName', {
      value: ecsStateRule.ruleName,
      description: 'EventBridge rule name for ECS task state changes',
      exportName: `ForgeEcsStateRuleName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'AlarmName', {
      value: fivexxAlarm.alarmName,
      description: 'CloudWatch alarm name for ALB 5xx rate',
      exportName: `ForgeAlbAlarmName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'EcsAlertLambdaArn', {
      value: ecsAlertLambda.functionArn,
      description: 'ARN of the ECS state-change alert Lambda',
    });
  }
}
