/**
 * Synth-level tests for ForgeTestingHarnessStack.
 *
 * These tests synthesize the stack in-memory and assert on the generated
 * CloudFormation template. They do NOT deploy anything.
 *
 * Covered:
 *   - Auto-pause Lambda exists and is wired to the harness SNS topic
 *   - Lambda env vars / handler reference the harness cluster + service
 *   - Lambda IAM policy includes scoped ECS UpdateService / StopTask /
 *     ListTasks / DescribeTasks permissions
 *   - AWS Budget still exists at USD 50 with the 50/80/100% thresholds
 *   - enableAutoPause=false correctly omits the Lambda + subscription
 *     while preserving the budget + SNS topic
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeTestingHarnessStack } from '../lib/forge-testing-harness-stack';
import {
  HARNESS_COST_CEILING_USD,
  HARNESS_BUDGET_THRESHOLDS_PERCENT,
} from '../lib/config/testing-harness-manifest';

function synth(enableAutoPause?: boolean): Template {
  const app = new cdk.App();
  // Host the VPC in a tiny parent stack so it can be passed in as a
  // property (same pattern as bin/forge-ecs-platform.ts uses).
  const parent = new cdk.Stack(app, 'Parent', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const sg = new ec2.SecurityGroup(parent, 'Sg', { vpc });

  const stack = new ForgeTestingHarnessStack(app, 'ForgeTestingHarness-test', {
    env: { account: '123456789012', region: 'us-east-1' },
    forgeEnv: 'test',
    vpc,
    ecsSecurityGroup: sg,
    privateSubnets: vpc.privateSubnets,
    omniAlbHost: 'omni.example.test',
    alertEmail: 'test@example.test',
    enableAutoPause,
  });
  return Template.fromStack(stack);
}

describe('ForgeTestingHarnessStack (auto-pause enabled)', () => {
  const template = synth(true);

  test('creates the auto-pause Lambda function', () => {
    // Note: CDK may also synthesize a log-retention helper Lambda, so we
    // don't assert an exact count — just that our named function exists.
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'forge-harness-auto-pause-test',
      Handler: 'index.handler',
      Runtime: Match.stringLikeRegexp('^python3'),
    });
  });

  test('Lambda has cluster + service env vars wired', () => {
    // Cluster/service names are CDK refs at synth time; match on shape,
    // not literal strings, and verify they point back to the harness
    // cluster/service logical IDs.
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'forge-harness-auto-pause-test' },
    });
    expect(Object.keys(fns)).toHaveLength(1);
    const [fn] = Object.values(fns) as any[];
    const vars = fn.Properties.Environment.Variables;
    expect(vars.AUTO_PAUSE_ENABLED).toBe('true');
    // HARNESS_CLUSTER_NAME -> Ref to the HarnessCluster logical ID
    const clusterRef = JSON.stringify(vars.HARNESS_CLUSTER_NAME);
    expect(clusterRef).toContain('HarnessCluster');
    // HARNESS_SERVICE_NAME -> Fn::GetAtt on the HarnessService logical ID
    const serviceRef = JSON.stringify(vars.HARNESS_SERVICE_NAME);
    expect(serviceRef).toContain('HarnessService');
  });

  test('SNS subscription wires the alert topic to the Lambda', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
    });
    // Lambda permission so SNS can invoke it
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'sns.amazonaws.com',
    });
  });

  test('IAM policy includes scoped ECS permissions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).toContain('ecs:UpdateService');
    expect(actions).toContain('ecs:StopTask');
    expect(actions).toContain('ecs:ListTasks');
    expect(actions).toContain('ecs:DescribeTasks');
    expect(actions).toContain('ecs:DescribeServices');
  });

  test('UpdateService is scoped to the harness service ARN', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );
    const updateService = statements.find((s: any) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes('ecs:UpdateService');
    });
    expect(updateService).toBeDefined();
    // Resource must reference the harness service via a CDK-synthesized
    // ARN (Ref to the HarnessService logical ID), never a wildcard.
    const resourceStr = JSON.stringify(updateService.Resource);
    expect(resourceStr).toContain('HarnessService');
    expect(resourceStr).toContain(':service/');
    expect(updateService.Resource).not.toBe('*');
  });

  test('StopTask is cluster-scoped via ArnEquals condition', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );
    const stopTask = statements.find((s: any) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes('ecs:StopTask');
    });
    expect(stopTask).toBeDefined();
    expect(stopTask.Condition).toBeDefined();
    const condJson = JSON.stringify(stopTask.Condition);
    expect(condJson).toContain('ArnEquals');
    expect(condJson).toContain('ecs:cluster');
  });

  test('budget USD 50 with 50/80/100% thresholds is preserved', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: HARNESS_COST_CEILING_USD, Unit: 'USD' },
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
      }),
    });
    const budgets = template.findResources('AWS::Budgets::Budget');
    const [budget] = Object.values(budgets) as any[];
    const thresholds = budget.Properties.NotificationsWithSubscribers.map(
      (n: any) => n.Notification.Threshold,
    );
    expect(thresholds.sort((a: number, b: number) => a - b)).toEqual(
      [...HARNESS_BUDGET_THRESHOLDS_PERCENT].sort((a, b) => a - b),
    );
  });

  test('harness ECS cluster and service are created', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'forge-testing-harness-test',
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'forge-testing-harness-test',
      DesiredCount: 0,
    });
  });

  test('SNS topic is named forge-harness-alerts', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'forge-harness-alerts',
    });
  });
});

describe('ForgeTestingHarnessStack (auto-pause disabled)', () => {
  const template = synth(false);

  test('no auto-pause Lambda is created', () => {
    const named = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'forge-harness-auto-pause-test' },
    });
    expect(Object.keys(named)).toHaveLength(0);
  });

  test('no lambda-protocol SNS subscription', () => {
    const subs = template.findResources('AWS::SNS::Subscription');
    for (const sub of Object.values(subs) as any[]) {
      expect(sub.Properties.Protocol).not.toBe('lambda');
    }
  });

  test('budget + SNS topic still exist', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'forge-harness-alerts',
    });
  });
});
