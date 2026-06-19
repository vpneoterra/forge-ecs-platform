/**
 * test/forge-omni-container-memory-4270137b.test.ts
 *
 * RC#2 (program 4270137b) infra enabler — the deployed omni-api container MUST
 * carry a container-level hard memory limit. Root cause amplifier of the OMNI
 * exit-137 crash-loop: the omni-api container had memory=null (only the
 * task-level 16384 MB), so an unbounded SdfShapeRouter placeholder mesh
 * OOM-killed the whole TASK before any terminal render callback. This synth-level
 * test asserts on the generated CloudFormation template; it does not deploy.
 *
 * Fails before the fix (Memory absent on the omni-api container def), passes
 * after.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';

function synth(forgeEnv: string): Template {
  const app = new cdk.App();
  const parent = new cdk.Stack(app, `Parent-${forgeEnv}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(parent, 'Vpc', { maxAzs: 2 });
  const ecsSg = new ec2.SecurityGroup(parent, 'EcsSg', { vpc });
  const albSg = new ec2.SecurityGroup(parent, 'AlbSg', { vpc });

  const stack = new ForgeAppStack(app, `ForgeApp-${forgeEnv}`, {
    env: { account: '123456789012', region: 'us-east-1' },
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

/** Find the omni-api container definition across all task defs in the template. */
function omniApiContainer(template: Template): any {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    const defs = td.Properties?.ContainerDefinitions ?? [];
    const omni = defs.find((c: any) => c.Name === 'omni-api');
    if (omni) return omni;
  }
  return null;
}

describe('RC#2 4270137b — omni-api container has a hard memory limit (GREEN/-dev2)', () => {
  test('the omni-api container definition exists and carries a non-null Memory', () => {
    const template = synth('dev2');
    const omni = omniApiContainer(template);
    expect(omni).not.toBeNull();
    // Memory is the container-level hard limit (memory=null was the defect).
    expect(typeof omni.Memory).toBe('number');
    expect(omni.Memory).toBeGreaterThan(0);
  });

  test('the container memory limit does not exceed the task-level memory', () => {
    const template = synth('dev2');
    const omni = omniApiContainer(template);
    // task-level is 16384; the container hard limit must be <= that.
    expect(omni.Memory).toBeLessThanOrEqual(16384);
    expect(omni.Memory).toBeGreaterThanOrEqual(8192); // a real budget, not a token
  });
});
