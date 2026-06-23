/**
 * test/forge-omni-metrics-parity.test.ts
 *
 * Synth-level PARITY guard for the OMNI/Render metrics-PUBLISHING contract.
 *
 * WHY THIS TEST EXISTS (RC-1)
 * ---------------------------
 * RC-2 (PR #129) wired the in-process RenderMetricsPublisher PRODUCER onto the
 * GREEN OMNI task def (the embedded `forge-omni` service in lib/forge-app-stack.ts)
 * — `OMNI_METRICS=on` plus a namespace-scoped `cloudwatch:PutMetricData` grant —
 * but NOT onto the SCALABLE-POOL `omni-<env>` task def (lib/forge-omni-stack.ts).
 *
 * The pool's autoscaling policies CONSUME the OMNI/Render BacklogPerTask /
 * QueueDepth series, yet the pool never PUBLISHES it: OMNI_METRICS was unset (the
 * publisher is gated off) AND the task role had no PutMetricData grant (every
 * publish would AccessDenied and be swallowed). So the pool's scalable target sits
 * on INSUFFICIENT_DATA forever and holds at the floor while backlog > 0 — a
 * consumer with no producer that passes CI because the existing RC-2 parity tests
 * only assert the CONSUMER exists.
 *
 * Both OMNI task defs now derive the producer contract from ONE source
 * (lib/config/omni-metrics-contract.ts) via applyOmniRenderMetrics — mirroring how
 * applyOmniMeshContract prevents FACET2 drift. This test synthesizes BOTH task
 * defs and FAILS THE BUILD if either lacks:
 *   - OMNI_METRICS == 'on' on the omni-api container, or
 *   - a cloudwatch:PutMetricData statement scoped to namespace OMNI/Render
 *     (Resource '*', StringEquals cloudwatch:namespace) with no broader scope.
 *
 * It deploys nothing.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeOmniStack } from '../lib/forge-omni-stack';
import { OMNI_BACKLOG_NAMESPACE } from '../lib/config/omni-backlog-metric';
import { OMNI_IMAGE_PIN_CONTEXT } from './helpers/image-pin';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';

function synthApp(forgeEnv: string): Template {
  const app = new cdk.App({ context: OMNI_IMAGE_PIN_CONTEXT });
  const parent = new cdk.Stack(app, `Parent-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
  });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const ecsSg = new ec2.SecurityGroup(parent, 'EcsSg', { vpc });
  const albSg = new ec2.SecurityGroup(parent, 'AlbSg', { vpc });

  const stack = new ForgeAppStack(app, `ForgeApp-${forgeEnv}`, {
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
  return Template.fromStack(stack);
}

function synthOmni(forgeEnv: string): Template {
  const app = new cdk.App({ context: OMNI_IMAGE_PIN_CONTEXT });
  const parent = new cdk.Stack(app, `OmniParent-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
  });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const ecsSg = new ec2.SecurityGroup(parent, 'EcsSg', { vpc });
  const albSg = new ec2.SecurityGroup(parent, 'AlbSg', { vpc });

  const stack = new ForgeOmniStack(app, `ForgeOmni-${forgeEnv}`, {
    env: { account: ACCOUNT, region: REGION },
    forgeEnv,
    vpc: vpc as ec2.Vpc,
    ecsSecurityGroup: ecsSg,
    albSecurityGroup: albSg,
    privateSubnets: vpc.privateSubnets,
    publicSubnets: vpc.publicSubnets,
    domainName: 'omni.qrucible.ai',
    hostedZoneDomain: 'qrucible.ai',
  });
  return Template.fromStack(stack);
}

/** The single omni-api container definition in a synthesized template. */
function omniApiContainer(template: Template): any {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    const containers = td.Properties.ContainerDefinitions as any[];
    for (const c of containers) {
      if (c.Name === 'omni-api') return c;
    }
  }
  throw new Error('omni-api container not found in synthesized template');
}

function envValue(container: any, key: string): string | undefined {
  const env = container.Environment as any[] | undefined;
  if (!env) return undefined;
  const hit = env.find((e) => e.Name === key);
  return hit ? (hit.Value as string) : undefined;
}

/** Every IAM policy statement in a synthesized template. */
function allStatements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const stmts: any[] = [];
  for (const p of Object.values(policies) as any[]) {
    stmts.push(...(p.Properties.PolicyDocument.Statement as any[]));
  }
  return stmts;
}

function putMetricDataStatements(template: Template): any[] {
  return allStatements(template).filter((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.includes('cloudwatch:PutMetricData');
  });
}

describe('OMNI/Render metrics producer parity — green vs scalable-pool task defs', () => {
  const greenTemplate = synthApp('dev2');
  const poolTemplate = synthOmni('dev2');
  const greenContainer = omniApiContainer(greenTemplate);
  const poolContainer = omniApiContainer(poolTemplate);

  test('OMNI_METRICS == "on" on BOTH omni-api containers (publisher enabled)', () => {
    expect(envValue(greenContainer, 'OMNI_METRICS')).toBe('on');
    expect(envValue(poolContainer, 'OMNI_METRICS')).toBe('on');
  });

  test('BOTH task roles carry a namespace-scoped PutMetricData grant', () => {
    for (const template of [greenTemplate, poolTemplate]) {
      const stmts = putMetricDataStatements(template);
      // The producer grant must be present...
      expect(stmts.length).toBeGreaterThan(0);
      for (const s of stmts) {
        // ...scoped to Resource '*' (PutMetricData has no resource-level ARN)...
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        expect(resources).toEqual(['*']);
        // ...and gated to the OMNI/Render namespace ONLY (no broader scope).
        expect(s.Condition).toBeDefined();
        expect(s.Condition.StringEquals['cloudwatch:namespace']).toBe(
          OMNI_BACKLOG_NAMESPACE,
        );
      }
    }
  });
});
