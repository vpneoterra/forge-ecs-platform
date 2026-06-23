/**
 * test/forge-omni-rc2-infra.test.ts
 *
 * Synth-level regression guards for the RC2 root-cause fixes (program 253f20a6
 * "Solar Nomad"). These assert the GENERATED CloudFormation template, so they
 * deploy nothing and fail loudly if any of the contracts below regress.
 *
 * Mapping to the RC2 deep-dive:
 *   RC2-A  OMNI task defs reference the container image by an IMMUTABLE @sha256
 *          digest, never the literal ':latest' tag.
 *   RC2-A  The OMNI ECR repo is created with ImageTagMutability == IMMUTABLE so a
 *          tag can never be silently overwritten (the digest a live service
 *          pinned can never be re-pointed).
 *   RC2-D/E The ECR lifecycle policy expires ONLY genuinely-unreferenced
 *          (untagged) images; there is NO maxImageCount sweep that could expire a
 *          digest an active task-def/running service still references.
 *   RC2-B  The OMNI render service registers an Application Auto Scaling scalable
 *          target on ecs:service:DesiredCount with a non-zero warm MinCapacity,
 *          and a scaling policy that CONSUMES the authoritative OMNI/Render
 *          backlog series (namespace OMNI/Render, metric BacklogPerTask, published
 *          by the render workers' RenderMetricsPublisher from omni.render_jobs
 *          ground truth) -- the series that reflects real queue pressure, replacing
 *          the dead FORGE/Platform backlog_per_task signal nothing could consume.
 *
 * Coverage spans BOTH OMNI render task definitions:
 *   - the standalone ForgeOmniStack service (image dim Service=omni-<env>), and
 *   - the embedded forge-omni service inside ForgeAppStack (Service=forge-omni).
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeOmniStack } from '../lib/forge-omni-stack';
import {
  OMNI_BACKLOG_NAMESPACE,
  OMNI_BACKLOG_PER_TASK_METRIC_NAME,
} from '../lib/config/omni-backlog-metric';
import { OMNI_IMAGE_PIN_CONTEXT, TEST_IMAGE_DIGEST } from './helpers/image-pin';

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

/** Recursively collect every string literal embedded anywhere in a value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

/**
 * RC2-A: assert the omni-api container Image is digest-pinned (carries the
 * pinned @sha256:<digest>) and never references the mutable ':latest' tag.
 */
function assertImageIsDigestPinnedNeverLatest(template: Template): void {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  let omniContainerFound = false;

  for (const td of Object.values(taskDefs) as any[]) {
    const containers = td.Properties.ContainerDefinitions as any[];
    for (const c of containers) {
      if (c.Name !== 'omni-api') continue;
      omniContainerFound = true;

      const imageStrings: string[] = [];
      collectStrings(c.Image, imageStrings);
      const joined = imageStrings.join('|');

      // The pinned digest must appear in the resolved image reference.
      expect(joined).toContain(`@${TEST_IMAGE_DIGEST}`);

      // The literal ':latest' tag must never be synthesized as a deploy ref.
      for (const s of imageStrings) {
        expect(s.endsWith(':latest')).toBe(false);
        expect(s).not.toMatch(/:latest$/);
      }
    }
  }

  expect(omniContainerFound).toBe(true);
}

/** RC2-A: the owned OMNI ECR repo must be IMMUTABLE-tagged. */
function assertEcrRepoImmutable(template: Template, repositoryName: string): void {
  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: repositoryName,
    ImageTagMutability: 'IMMUTABLE',
  });
}

/**
 * RC2-D/E: the lifecycle policy must NOT contain a maxImageCount/imageCountMoreThan
 * sweep (which could expire a digest a running service still pins). Only an
 * untagged-image (genuinely unreferenced) expiry rule is permitted.
 */
function assertLifecycleHasNoImageCountSweep(
  template: Template,
  repositoryName: string,
): void {
  const repos = template.findResources('AWS::ECR::Repository');
  let checked = false;
  for (const repo of Object.values(repos) as any[]) {
    if (repo.Properties.RepositoryName !== repositoryName) continue;
    checked = true;
    const lifecycle = repo.Properties.LifecyclePolicy;
    expect(lifecycle).toBeDefined();
    const text: string = lifecycle.LifecyclePolicyText;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    for (const rule of parsed.rules as any[]) {
      // A count sweep would key on imageCountMoreThan; an age sweep on tagged
      // images would use tagStatus tagged/any. Neither is allowed here.
      expect(rule.selection.countType).not.toBe('imageCountMoreThan');
      expect(rule.selection.tagStatus).toBe('untagged');
    }
  }
  expect(checked).toBe(true);
}

/**
 * RC2-B: a scalable target on ecs:service:DesiredCount must exist with a non-zero
 * warm MinCapacity (so capacity is already present inside the 900s W6 window and
 * never floored to 0 while backlog>0).
 */
function assertWarmScalableTarget(template: Template, expectedMax: number): void {
  const targets = template.findResources(
    'AWS::ApplicationAutoScaling::ScalableTarget',
  );
  const omniTargets = (Object.values(targets) as any[]).filter(
    (t) => t.Properties.ScalableDimension === 'ecs:service:DesiredCount',
  );
  expect(omniTargets.length).toBeGreaterThan(0);

  // Min is the warm floor (never 0); Max is asserted EXACTLY against each
  // stack's live contract. The standalone pool runs min=1/max=4 (the standing
  // capacity rule, reconciled to the live omni:25 target); the green
  // ForgeAppStack anchor runs max=6 (its observed 5-concurrent peak + headroom).
  for (const t of omniTargets) {
    expect(Number(t.Properties.MinCapacity)).toBe(1);
    expect(Number(t.Properties.MaxCapacity)).toBe(expectedMax);
  }
}

/**
 * RC2-B: a scaling policy must CONSUME the authoritative OMNI render backlog
 * series -- a target-tracking policy whose customized metric is OMNI/Render
 * BacklogPerTask (published by RenderMetricsPublisher), replacing the dead
 * FORGE/Platform backlog_per_task signal.
 */
function assertBacklogMetricConsumed(template: Template): void {
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
    PolicyType: 'TargetTrackingScaling',
    TargetTrackingScalingPolicyConfiguration: {
      CustomizedMetricSpecification: Match.objectLike({
        Namespace: OMNI_BACKLOG_NAMESPACE,
        MetricName: OMNI_BACKLOG_PER_TASK_METRIC_NAME,
      }),
    },
  });
}

describe('ForgeOmniStack (standalone) — RC2 infra contracts', () => {
  const template = synthOmni('dev2');

  test('RC2-A: omni-api image is @sha256 digest-pinned, never :latest', () => {
    assertImageIsDigestPinnedNeverLatest(template);
  });

  test('RC2-A: OMNI ECR repo is created IMMUTABLE', () => {
    assertEcrRepoImmutable(template, 'forge-omni-dev2');
  });

  test('RC2-D/E: lifecycle policy has no maxImageCount sweep (untagged-only expiry)', () => {
    assertLifecycleHasNoImageCountSweep(template, 'forge-omni-dev2');
  });

  test('RC2-B: warm scalable target on ecs:service:DesiredCount (Min=1, Max=4)', () => {
    assertWarmScalableTarget(template, 4);
  });

  test('RC2-B: a scaling policy consumes the OMNI/Render backlog series (BacklogPerTask)', () => {
    assertBacklogMetricConsumed(template);
  });
});

describe('ForgeAppStack embedded forge-omni service — RC2 infra contracts', () => {
  const template = synthApp('dev2');

  test('RC2-A: omni-api image is @sha256 digest-pinned, never :latest', () => {
    assertImageIsDigestPinnedNeverLatest(template);
  });

  test('RC2-B: warm scalable target on ecs:service:DesiredCount (Min=1, Max=6)', () => {
    assertWarmScalableTarget(template, 6);
  });

  test('RC2-B: a scaling policy consumes the OMNI/Render backlog series (BacklogPerTask)', () => {
    assertBacklogMetricConsumed(template);
  });
});
