/**
 * test/forge-omni-artifacts-iam.test.ts
 *
 * ROOT-CAUSE regression guard for the OMNI render-fleet S3 AccessDenied bug.
 *
 * The OMNI render fleet (BomRenderWorker) writes rendered GLB/STL artifacts to
 * s3://forge-omni-artifacts-<account>-<region>/renders/<...>, but the task role
 * (ForgeApp-dev2-TaskRole, logical policy id TaskRoleDefaultPolicy07FC53DE)
 * granted s3:PutObject ONLY on forge-cem-assets/* and forge-platform-data-
 * <...>/abc/*. The artifacts bucket was in NO policy statement, so every
 * per-part PutObject returned AccessDenied -> OMNI produced zero GLBs ->
 * declared GeometryEmpty -> never returned a source_model_url -> the W6
 * geometry-lock predicate (with_source_model_url > 0) could never pass and the
 * whole program failed.
 *
 * These synth-level tests assert the generated CloudFormation template carries
 * the scoped renders/* grant. They are deny-by-default: if the grant is ever
 * dropped, the first test fails loudly. They do NOT deploy anything.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeOmniStack } from '../lib/forge-omni-stack';
import { OMNI_IMAGE_PIN_CONTEXT } from './helpers/image-pin';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ARTIFACTS_BUCKET = `forge-omni-artifacts-${ACCOUNT}-${REGION}`;

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

/** Assert the artifacts renders/* grant is present and least-privilege. */
function assertArtifactsGrant(template: Template): void {
  // Object-level grant scoped to the renders/* prefix.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'OmniArtifactsRendersWrite',
          Effect: 'Allow',
          Action: Match.arrayWith(['s3:PutObject']),
          Resource: `arn:aws:s3:::${ARTIFACTS_BUCKET}/renders/*`,
        }),
      ]),
    },
  });

  // Bucket-level list/location grant on the bucket itself.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'OmniArtifactsList',
          Effect: 'Allow',
          Action: Match.arrayWith(['s3:ListBucket']),
          Resource: `arn:aws:s3:::${ARTIFACTS_BUCKET}`,
        }),
      ]),
    },
  });
}

/** No statement anywhere may use the s3:* action wildcard or Resource '*'. */
function assertNoWildcards(template: Template): void {
  const policies = template.findResources('AWS::IAM::Policy');
  for (const pol of Object.values(policies) as any[]) {
    for (const stmt of pol.Properties.PolicyDocument.Statement as any[]) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      expect(actions).not.toContain('s3:*');
      if (actions.includes('s3:PutObject')) {
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const r of resources) {
          expect(r).not.toBe('*');
          expect(r).not.toBe('arn:aws:s3:::*');
        }
      }
    }
  }
}

describe('ForgeAppStack (dev2) — OMNI render artifacts S3 grant (root-cause fix)', () => {
  const template = synthApp('dev2');

  test('task role grants PutObject + multipart actions on forge-omni-artifacts/renders/*', () => {
    assertArtifactsGrant(template);
  });

  test('renders/* object grant carries only the multipart-upload object actions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    let found = false;
    for (const pol of Object.values(policies) as any[]) {
      for (const stmt of pol.Properties.PolicyDocument.Statement as any[]) {
        if (stmt.Sid === 'OmniArtifactsRendersWrite') {
          found = true;
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          expect(actions).toEqual(
            expect.arrayContaining([
              's3:PutObject',
              's3:PutObjectAcl',
              's3:AbortMultipartUpload',
              's3:ListMultipartUploadParts',
              's3:GetObject',
            ]),
          );
          expect(actions).not.toContain('s3:*');
          expect(actions).not.toContain('s3:DeleteObject');
        }
      }
    }
    expect(found).toBe(true);
  });

  test('no task-role statement uses an s3:* or Resource:* wildcard', () => {
    assertNoWildcards(template);
  });
});

describe('ForgeOmniStack (dev2) — standalone render fleet artifacts S3 grant', () => {
  const template = synthOmni('dev2');

  test('standalone OMNI task role also carries the renders/* artifacts grant', () => {
    assertArtifactsGrant(template);
  });

  test('no task-role statement uses an s3:* or Resource:* wildcard', () => {
    assertNoWildcards(template);
  });
});
