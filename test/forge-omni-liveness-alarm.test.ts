/**
 * test/forge-omni-liveness-alarm.test.ts
 *
 * Synth-level guard for RC-3: the OMNI render backlog producer must be watched by
 * a CloudWatch liveness alarm so a DEAD producer pages instead of silently
 * stranding the scalable target on INSUFFICIENT_DATA.
 *
 * WHY THIS TEST EXISTS (RC-3)
 * ---------------------------
 * The OMNI scalable target consumes the OMNI/Render QueueDepth series
 * (config/omni-backlog-metric.ts). If RenderMetricsPublisher stops emitting
 * (crash, AccessDenied, OMNI_METRICS unset), the metric simply goes MISSING:
 * autoscaling freezes at the floor with backlog > 0 and nothing pages. A normal
 * threshold alarm cannot catch this because QueueDepth is always >= 0 and never
 * crosses an upper bound when it disappears.
 *
 * THE FIX: a liveness alarm on OMNI/Render QueueDepth (ServiceName=forge-omni)
 * with treatMissingData=BREACHING, wired to the existing forge-deploy-alerts SNS
 * topic. Present data (>= 0) never trips it; MISSING data (producer dead) does.
 *
 * It deploys nothing.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeMonitoringStack } from '../lib/forge-monitoring-stack';
import {
  OMNI_BACKLOG_NAMESPACE,
  OMNI_BACKLOG_METRIC_NAME,
  OMNI_BACKLOG_SERVICE_DIMENSION,
} from '../lib/config/omni-backlog-metric';
import { OMNI_IMAGE_PIN_CONTEXT } from './helpers/image-pin';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function synthMonitoring(forgeEnv: string): Template {
  const app = new cdk.App({ context: OMNI_IMAGE_PIN_CONTEXT });
  const parent = new cdk.Stack(app, `Parent-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
  });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const ecsSg = new ec2.SecurityGroup(parent, 'EcsSg', { vpc });
  const albSg = new ec2.SecurityGroup(parent, 'AlbSg', { vpc });

  const appStack = new ForgeAppStack(app, `ForgeApp-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
    forgeEnv,
    vpc: vpc as ec2.Vpc,
    ecsSecurityGroup: ecsSg,
    albSecurityGroup: albSg,
    privateSubnets: vpc.privateSubnets,
    publicSubnets: vpc.publicSubnets,
    domainName: 'forge.qrucible.ai',
    omniDomainName: 'omni.qrucible.ai',
    hostedZoneDomain: 'qrucible.ai',
  });

  const monitoringStack = new ForgeMonitoringStack(app, `ForgeMonitoring-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
    forgeEnv,
    alb: appStack.alb,
    ecsCluster: appStack.ecsCluster,
    ecsServiceName: appStack.serviceName,
    alertEmail: 'ops@qrucible.ai',
  });
  return Template.fromStack(monitoringStack);
}

describe('RC-3 — OMNI/Render QueueDepth liveness alarm', () => {
  const template = synthMonitoring('dev2');

  test('an alarm watches OMNI/Render QueueDepth for ServiceName=forge-omni, breaching on missing data', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: OMNI_BACKLOG_NAMESPACE,
      MetricName: OMNI_BACKLOG_METRIC_NAME,
      Dimensions: Match.arrayWith([
        { Name: OMNI_BACKLOG_SERVICE_DIMENSION, Value: 'forge-omni' },
      ]),
      TreatMissingData: 'breaching',
    });
  });

  test('the liveness alarm fires an action onto the forge-deploy-alerts SNS topic', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: OMNI_BACKLOG_NAMESPACE,
      MetricName: OMNI_BACKLOG_METRIC_NAME,
      TreatMissingData: 'breaching',
      AlarmActions: Match.arrayWith([
        Match.stringLikeRegexp('forge-deploy-alerts'),
      ]),
    });
  });
});
