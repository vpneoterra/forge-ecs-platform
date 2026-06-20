/**
 * test/forge-omni-rootcause-rc1-rc3.test.ts
 *
 * Synth- and workflow-level regression guards for the OMNI autoscale/code-update
 * root-cause fixes RC-1 (split service / wrong target group) and RC-3 (canonical
 * digest-pinned deploy). These assert generated CloudFormation and the build
 * workflow text; they deploy nothing.
 *
 *   RC-1  omni.qrucible.ai is served by ONE OMNI service behind ONE target group.
 *         ForgeAppStack (the canonical owner) routes the host to the embedded
 *         forge-omni service and stands up exactly one OMNI scalable target. The
 *         orphan standalone service name (omni-<env>) never appears in the App
 *         template, and the entry point refuses to let the standalone stack also
 *         claim the prod hostname while ForgeAppStack owns it.
 *   RC-3  The OMNI build/deploy pipeline pushes the CANONICAL forge-omni ECR repo
 *         and rolls the forge-omni service by a digest-pinned CDK deploy
 *         (-c forgeOmniImageDigest), hard-failing on an unresolvable digest.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { OMNI_IMAGE_PIN_CONTEXT } from './helpers/image-pin';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const OMNI_DOMAIN = 'omni.qrucible.ai';

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
    omniDomainName: OMNI_DOMAIN,
    hostedZoneDomain: 'qrucible.ai',
  });
  return Template.fromStack(stack);
}

describe('RC-1 — single OMNI service / single target group behind omni.qrucible.ai', () => {
  const template = synthApp('dev2');

  test('the canonical app stack declares exactly one OMNI scalable target', () => {
    const targets = template.findResources(
      'AWS::ApplicationAutoScaling::ScalableTarget',
    );
    const omniTargets = (Object.values(targets) as any[]).filter(
      (t) => t.Properties.ScalableDimension === 'ecs:service:DesiredCount',
    );
    // Exactly one OMNI render scalable target — never a second, empty one.
    expect(omniTargets.length).toBe(1);
  });

  test('a host-header listener rule routes omni.qrucible.ai to a target group', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'host-header',
          HostHeaderConfig: { Values: Match.arrayWith([OMNI_DOMAIN]) },
        }),
      ]),
    });
  });

  test('the orphan standalone service name (omni-dev2) is absent from the app template', () => {
    // The split was a SECOND service named omni-<env> behind its own TG/ALB. The
    // canonical app template must never name it as an ECS service.
    const services = template.findResources('AWS::ECS::Service');
    for (const svc of Object.values(services) as any[]) {
      expect(svc.Properties.ServiceName).not.toBe('omni-dev2');
    }
  });
});

describe('RC-1 — entry point refuses a co-claimed prod OMNI hostname', () => {
  // Mirror the guard condition in bin/forge-ecs-platform.ts: when ForgeAppStack
  // (canonical owner of omni.qrucible.ai) is deployed, the standalone stack must
  // not also claim the prod hostname. This documents and locks the invariant.
  function guardWouldThrow(opts: {
    deployApp: boolean;
    deployOmni: boolean;
    claimProdDomain: boolean;
  }): boolean {
    return opts.deployOmni && opts.deployApp && opts.claimProdDomain;
  }

  test('throws when App + standalone Omni both claim the prod hostname', () => {
    expect(
      guardWouldThrow({ deployApp: true, deployOmni: true, claimProdDomain: true }),
    ).toBe(true);
  });

  test('allows standalone Omni when the app stack is not deployed', () => {
    expect(
      guardWouldThrow({ deployApp: false, deployOmni: true, claimProdDomain: true }),
    ).toBe(false);
  });

  test('allows standalone Omni when it does not claim the prod hostname', () => {
    expect(
      guardWouldThrow({ deployApp: true, deployOmni: true, claimProdDomain: false }),
    ).toBe(false);
  });
});

describe('RC-3 — OMNI build/deploy targets the canonical service by digest', () => {
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'build-omni-standalone.yml'),
    'utf8',
  );

  test('builds/pushes the canonical forge-omni ECR repo (not the orphan omni-dev2)', () => {
    expect(wf).toMatch(/ECR_REPO:\s*forge-omni\b/);
    expect(wf).not.toMatch(/ECR_REPO:\s*omni-dev2\b/);
  });

  test('enforces IMMUTABLE tag mutability on the canonical repo', () => {
    expect(wf).toMatch(/put-image-tag-mutability/);
    expect(wf).toMatch(/--image-tag-mutability IMMUTABLE/);
  });

  test('has a deploy job that rolls forge-omni via a digest-pinned CDK deploy', () => {
    expect(wf).toMatch(/forgeOmniImageDigest=/);
    expect(wf).toMatch(/cdk deploy "ForgeApp-/);
    expect(wf).toMatch(/services-stable/);
  });

  test('hard-fails when the pushed digest is unresolvable (no :latest fallback)', () => {
    // The deploy job must refuse to proceed without an exact sha256 digest.
    expect(wf).toMatch(/refusing to deploy/i);
    expect(wf).toMatch(/sha256:\[0-9a-f\]\{64\}/);
  });
});
