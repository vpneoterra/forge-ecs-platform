/**
 * test/forge-omni-facet2-parity.test.ts
 *
 * Synth-level PARITY guard for the OMNI FACET2 mesh-authoring contract.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * PR #133 wired FACET2 authoring end-to-end onto the GREEN OMNI task def
 * (the embedded `forge-omni` service in lib/forge-app-stack.ts) but NOT onto
 * the SCALABLE-POOL `omni-<env>` task def (lib/forge-omni-stack.ts). On run
 * atlas-41ce3232-pressure-hull the pool therefore could not READ FACET2-authored
 * meshes (no EFS mount) and did not ENFORCE the kernel guard
 * (FACET2_OMNI_GUARD UNSET), so class=SHELL parts fell into the voxel path and
 * died with EmptyMeshException (5/5). Green and pool ran the SAME image but made
 * OPPOSITE safety decisions purely because of CDK config divergence.
 *
 * Both OMNI task defs now derive their FACET2 env + EFS mesh mount from ONE
 * source (lib/config/omni-mesh-contract.ts) via applyOmniMeshContract. This test
 * synthesizes BOTH task defs and FAILS THE BUILD if they ever diverge on:
 *   - the shared FACET2 env keys/values (OMNI_FACET2_SHARED_ENV), or
 *   - the shared mesh EFS volume + read-only mount at OMNI_MESH_ARTIFACTS_ROOT, or
 *   - the read-only ClientMount grant (and the absence of any ClientWrite).
 *
 * It deploys nothing.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeOmniStack } from '../lib/forge-omni-stack';
import {
  OMNI_FACET2_SHARED_ENV,
  OMNI_MESH_VOLUME_NAME,
  OMNI_MESH_ARTIFACTS_ROOT,
  OMNI_MESH_EFS_FILESYSTEM_ID,
  OMNI_MESH_EFS_ACCESS_POINT_ID,
} from '../lib/config/omni-mesh-contract';
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

/** The task definition resource that owns the omni-api container. */
function omniApiTaskDef(template: Template): any {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    const containers = td.Properties.ContainerDefinitions as any[];
    if (containers.some((c) => c.Name === 'omni-api')) return td;
  }
  throw new Error('omni-api task definition not found');
}

/**
 * Extract the resolved value of an environment key from an omni-api container.
 * The container env is an array of { Name, Value } entries. Shared-contract
 * values here are plain string literals (no CFN intrinsics), so a direct
 * string compare is valid.
 */
function envValue(container: any, key: string): string | undefined {
  const env = container.Environment as any[] | undefined;
  if (!env) return undefined;
  const hit = env.find((e) => e.Name === key);
  return hit ? (hit.Value as string) : undefined;
}

/** The mesh-store EFS volume entry on a task def, by logical volume name. */
function meshVolume(taskDef: any): any {
  const volumes = (taskDef.Properties.Volumes as any[]) ?? [];
  return volumes.find((v) => v.Name === OMNI_MESH_VOLUME_NAME);
}

/** The omni-api mount point targeting the mesh volume. */
function meshMountPoint(container: any): any {
  const mounts = (container.MountPoints as any[]) ?? [];
  return mounts.find((m) => m.SourceVolume === OMNI_MESH_VOLUME_NAME);
}

describe('OMNI FACET2 contract parity — green vs scalable-pool task defs', () => {
  const greenContainer = omniApiContainer(synthApp('dev2'));
  const poolContainer = omniApiContainer(synthOmni('dev2'));
  const greenTaskDef = omniApiTaskDef(synthApp('dev2'));
  const poolTaskDef = omniApiTaskDef(synthOmni('dev2'));

  test('both task defs carry the IDENTICAL shared FACET2 env keys/values', () => {
    for (const [key, expected] of Object.entries(OMNI_FACET2_SHARED_ENV)) {
      const greenVal = envValue(greenContainer, key);
      const poolVal = envValue(poolContainer, key);
      // Present on both...
      expect(greenVal).toBeDefined();
      expect(poolVal).toBeDefined();
      // ...equal to the single-sourced contract value...
      expect(greenVal).toBe(expected);
      expect(poolVal).toBe(expected);
      // ...and equal to EACH OTHER (the anti-divergence invariant).
      expect(poolVal).toBe(greenVal);
    }
  });

  test('FACET2_OMNI_GUARD is true on BOTH (kernel guard enforced everywhere)', () => {
    expect(envValue(greenContainer, 'FACET2_OMNI_GUARD')).toBe('true');
    expect(envValue(poolContainer, 'FACET2_OMNI_GUARD')).toBe('true');
  });

  test('both task defs mount the SAME mesh EFS volume (literal fs/ap ids)', () => {
    for (const td of [greenTaskDef, poolTaskDef]) {
      const vol = meshVolume(td);
      expect(vol).toBeDefined();
      const efs = vol.EFSVolumeConfiguration;
      expect(efs.FilesystemId).toBe(OMNI_MESH_EFS_FILESYSTEM_ID);
      expect(efs.TransitEncryption).toBe('ENABLED');
      expect(efs.AuthorizationConfig.AccessPointId).toBe(
        OMNI_MESH_EFS_ACCESS_POINT_ID,
      );
      expect(efs.AuthorizationConfig.IAM).toBe('ENABLED');
    }
  });

  test('both omni-api containers mount the mesh READ-ONLY at the shared root', () => {
    for (const c of [greenContainer, poolContainer]) {
      const mp = meshMountPoint(c);
      expect(mp).toBeDefined();
      expect(mp.ContainerPath).toBe(OMNI_MESH_ARTIFACTS_ROOT);
      expect(mp.ReadOnly).toBe(true);
    }
  });

  test('both task roles get ClientMount and NEVER ClientWrite on the mesh FS', () => {
    for (const template of [synthApp('dev2'), synthOmni('dev2')]) {
      const policies = template.findResources('AWS::IAM::Policy');
      const allStatements: any[] = [];
      for (const p of Object.values(policies) as any[]) {
        const stmts = p.Properties.PolicyDocument.Statement as any[];
        allStatements.push(...stmts);
      }
      const mountStmts = allStatements.filter((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('elasticfilesystem:ClientMount');
      });
      // The read-only mount grant must be present...
      expect(mountStmts.length).toBeGreaterThan(0);
      // ...and NO statement anywhere may grant ClientWrite (FACET2 is the sole
      // writer; OMNI only reads authored meshes).
      const writeStrings: string[] = [];
      collectStrings(
        allStatements.map((s) => s.Action),
        writeStrings,
      );
      expect(writeStrings).not.toContain('elasticfilesystem:ClientWrite');
    }
  });
});
