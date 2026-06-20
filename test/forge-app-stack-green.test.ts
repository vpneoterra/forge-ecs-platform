/**
 * Synth-level tests for ForgeAppStack on the GREEN (-dev2) path.
 *
 * These tests synthesize the stack in-memory and assert on the generated
 * CloudFormation template. They do NOT deploy anything.
 *
 * Covered (regression guards for the two root causes fixed in
 * fix/green-omni-discovery-and-cem-assets-iam):
 *
 *   RC-B: the embedded OMNI task definition's ENRICHMENT_BRIDGE_URL must point
 *         at the GREEN forge-app service-discovery name (forge-app-dev2.forge.local)
 *         and NOT the BLUE name (forge-app-test.forge.local). FluxTK__BaseUrl is
 *         left at the env-agnostic geometry Cloud Map name the stack itself
 *         defines for every env (forge-fluxtk.forge-geometry.local).
 *
 *   RC-C: the forge-app task role must grant s3:PutObject on the
 *         forge-cem-assets bucket (the bucket the app + forge-dks sidecar write
 *         AIN/monitor snapshots and CEM assets to), scoped to that bucket only
 *         (no s3:* and no all-buckets wildcard).
 *
 * BLUE non-regression: the legacy dev env keeps forge-app-test.forge.local.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { OMNI_IMAGE_PIN_CONTEXT } from './helpers/image-pin';

function synth(forgeEnv: string): Template {
  // Pin the OMNI image to an immutable digest (RC2-A/RC2-C). resolveEcrImage
  // requires this at synth time exactly as CI does at deploy time.
  const app = new cdk.App({ context: OMNI_IMAGE_PIN_CONTEXT });
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

/** Pull the env-var array for a named container out of every task definition. */
function envForContainer(template: Template, containerName: string): Record<string, string> {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    const defs = td.Properties.ContainerDefinitions as any[];
    const match = defs.find((c) => c.Name === containerName);
    if (match) {
      const out: Record<string, string> = {};
      for (const kv of match.Environment ?? []) {
        // Only capture plain string env values (skip CFN intrinsics).
        if (typeof kv.Value === 'string') out[kv.Name] = kv.Value;
      }
      return out;
    }
  }
  throw new Error(`container '${containerName}' not found in any task definition`);
}

describe('ForgeAppStack GREEN (dev2) — RC-B OMNI service discovery', () => {
  const template = synth('dev2');
  const omniEnv = envForContainer(template, 'omni-api');

  test('ENRICHMENT_BRIDGE_URL points at the GREEN forge-app discovery name', () => {
    expect(omniEnv.ENRICHMENT_BRIDGE_URL).toBe(
      'http://forge-app-dev2.forge.local:3000/api/omni-enriched',
    );
  });

  test('ENRICHMENT_BRIDGE_URL does not contain the BLUE name forge-app-test', () => {
    expect(omniEnv.ENRICHMENT_BRIDGE_URL).not.toContain('forge-app-test');
  });

  test('FluxTK__BaseUrl uses the env-agnostic geometry Cloud Map name the stack defines', () => {
    // forge-fluxtk.forge-geometry.local is the per-VPC Cloud Map A-record the
    // geometry stack registers in every env; it is NOT a BLUE-only literal, so
    // it is intentionally unchanged. (No GREEN-distinct fluxtk hostname exists
    // in the stack to derive from.)
    expect(omniEnv.FluxTK__BaseUrl).toBe('http://forge-fluxtk.forge-geometry.local:8040');
  });
});

describe('ForgeAppStack BLUE (dev) — RC-B non-regression', () => {
  const template = synth('dev');
  const omniEnv = envForContainer(template, 'omni-api');

  test('ENRICHMENT_BRIDGE_URL keeps the legacy forge-app-test discovery name', () => {
    expect(omniEnv.ENRICHMENT_BRIDGE_URL).toBe(
      'http://forge-app-test.forge.local:3000/api/omni-enriched',
    );
  });
});

describe('ForgeAppStack — RC-C forge-cem-assets task-role grant', () => {
  const template = synth('dev2');

  test('task role policy grants s3:PutObject on forge-cem-assets objects', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CemAssetsS3ObjectReadWrite',
            Effect: 'Allow',
            Action: Match.arrayWith(['s3:PutObject']),
            Resource: 'arn:aws:s3:::forge-cem-assets/*',
          }),
        ]),
      },
    });
  });

  test('task role policy grants ListBucket on the forge-cem-assets bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CemAssetsS3List',
            Effect: 'Allow',
            Action: Match.arrayWith(['s3:ListBucket']),
            Resource: 'arn:aws:s3:::forge-cem-assets',
          }),
        ]),
      },
    });
  });

  test('no task-role statement grants the s3:* wildcard action', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const pol of Object.values(policies) as any[]) {
      for (const stmt of pol.Properties.PolicyDocument.Statement as any[]) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        expect(actions).not.toContain('s3:*');
      }
    }
  });

  test('forge-cem-assets object grant is not scoped to the unrelated s3:* on all buckets', () => {
    // Guard against accidental broadening to arn:aws:s3:::* for object actions.
    const policies = template.findResources('AWS::IAM::Policy');
    for (const pol of Object.values(policies) as any[]) {
      for (const stmt of pol.Properties.PolicyDocument.Statement as any[]) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        if (actions.includes('s3:PutObject')) {
          const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
          for (const r of resources) {
            expect(r).not.toBe('*');
            expect(r).not.toBe('arn:aws:s3:::*');
          }
        }
      }
    }
  });
});

describe('ForgeAppStack — FIX d560d7d6 OMNI bridge programs/* GLB write', () => {
  const template = synth('dev2');

  test('task role pins the exact minimum multipart-upload grant on programs/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CemAssetsProgramsGlbWrite',
            Effect: 'Allow',
            Action: [
              's3:PutObject',
              's3:PutObjectAcl',
              's3:AbortMultipartUpload',
            ],
            Resource: 'arn:aws:s3:::forge-cem-assets/programs/*',
          }),
        ]),
      },
    });
  });

  test('programs/* grant carries no read/delete/list actions (write-only, least privilege)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    let found = false;
    for (const pol of Object.values(policies) as any[]) {
      for (const stmt of pol.Properties.PolicyDocument.Statement as any[]) {
        if (stmt.Sid === 'CemAssetsProgramsGlbWrite') {
          found = true;
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          expect(actions).not.toContain('s3:*');
          expect(actions).not.toContain('s3:GetObject');
          expect(actions).not.toContain('s3:DeleteObject');
          expect(actions).not.toContain('s3:ListBucket');
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('ForgeAppStack — FIX d560d7d6 ASSET_CDN_BASE present for dev2', () => {
  const template = synth('dev2');
  const appEnv = envForContainer(template, 'forge-app');

  test('ASSET_CDN_BASE is set so persisted GLBs have a CDN-retrievable URL', () => {
    expect(appEnv.ASSET_CDN_BASE).toBeDefined();
    expect(appEnv.ASSET_CDN_BASE).toMatch(/^https:\/\//);
  });
});
