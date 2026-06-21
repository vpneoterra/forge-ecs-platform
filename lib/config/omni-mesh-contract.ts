/**
 * SINGLE SOURCE OF TRUTH for the OMNI FACET2 mesh-authoring contract shared by
 * BOTH OMNI render task definitions:
 *   - the GREEN embedded `forge-omni` service in lib/forge-app-stack.ts, and
 *   - the SCALABLE-POOL `omni-<env>` service in lib/forge-omni-stack.ts.
 *
 * WHY THIS FILE EXISTS (RC2 anti-regression)
 * ------------------------------------------
 * PR #133 wired FACET2 authoring end-to-end, but ONLY for the green OMNI task
 * def — the scalable-pool task def (`omni:25`, built by forge-omni-stack.ts)
 * never received the same wiring. In live run `atlas-41ce3232-pressure-hull`
 * the pool therefore (a) could not READ FACET2-authored meshes (no EFS mount)
 * and (b) did not ENFORCE the kernel guard (`FACET2_OMNI_GUARD` UNSET), so
 * class=SHELL parts fell into the voxel path and died with EmptyMeshException
 * (5/5 failures). Green and pool ran the SAME image but made OPPOSITE safety
 * decisions purely because of a configuration divergence in CDK.
 *
 * To make that divergence STRUCTURALLY IMPOSSIBLE, the env contract and the
 * EFS volume/mount/grant are declared ONCE here and applied by BOTH stacks via
 * `applyOmniMeshContract`. A CDK assertion test
 * (test/forge-omni-facet2-parity.test.ts) synthesizes both task defs and fails
 * the build if they ever diverge on these keys or on the mesh mount.
 *
 * The shared task role grant is read-only (`elasticfilesystem:ClientMount`,
 * NO ClientWrite): OMNI only READS authored meshes; FACET2 is the sole writer
 * (RW on its own out-of-band task def).
 */

import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Pre-existing standalone `mesh-blob-store` EFS that the FACET2 service writes
 * its authored OCCT/build123d meshes to. Referenced by LITERAL id (NOT an
 * efs.FileSystem construct) on purpose: this filesystem is owned out-of-band
 * (declared on the FACET2 task def, not by any CDK stack here). Constructing a
 * new efs.FileSystem would attempt to create/manage a DUPLICATE FS and orphan
 * FACET2's data. These are the identical ids PR #133 mounted for green.
 */
export const OMNI_MESH_EFS_FILESYSTEM_ID = 'fs-0e25dddff6e362811';
export const OMNI_MESH_EFS_ACCESS_POINT_ID = 'fsap-0676f4a4aeb6825a9';

/** Logical volume name + container mount path for the shared mesh store. */
export const OMNI_MESH_VOLUME_NAME = 'mesh-blob-store';
export const OMNI_MESH_ARTIFACTS_ROOT = '/var/facet2/mesh';

/**
 * FluxTK conservation-solver discovery URL.
 *
 * VERIFIED REGISTRATION (do NOT change without re-verifying against the CDK):
 * forge-fluxtk is registered in the `forge-geometry.local` Cloud Map namespace
 * by lib/forge-geometry-stack.ts (PrivateDnsNamespace name='forge-geometry.local',
 * the FluxTK FargateService registers with cloudMapName='forge-fluxtk' on
 * port 8040 — see lib/config/geometry-manifest.ts CAP_FLUXTK). So the actual
 * registered FQDN IS `forge-fluxtk.forge-geometry.local:8040`, which is exactly
 * the value below. ASP.NET maps `FluxTK__BaseUrl` (double underscore) to the
 * configuration key `FluxTK:BaseUrl`.
 *
 * NOTE (FluxTK reachability — flagged, NOT silently changed): the
 * atlas-41ce3232-pressure-hull RCA reported this name failing to resolve at
 * runtime and suggested the `forge.local` namespace instead. That suggestion is
 * NOT applied here because it is contradicted by the repo's own ground truth:
 * forge-fluxtk is registered in `forge-geometry.local`, NOT `forge.local`, and
 * the existing green regression test (test/forge-app-stack-green.test.ts)
 * explicitly asserts this exact URL and that it must not be rewritten to a BLUE/
 * forge.local literal. Rewriting it to `forge-fluxtk.forge.local` would point at
 * a namespace where forge-fluxtk is NOT registered — a guaranteed NXDOMAIN, i.e.
 * a regression. The observed runtime resolution failure is therefore a
 * deployment-state issue (the geometry stack / its Cloud Map namespace VPC
 * association), NOT a wrong literal in the OMNI task-def env, and is out of scope
 * for this task-def parity fix. Single-sourcing the URL here at least guarantees
 * green and pool stay identical so any future correction lands in ONE place.
 */
export const OMNI_FLUXTK_BASE_URL = 'http://forge-fluxtk.forge-geometry.local:8040';

/**
 * The shared OMNI behavioural FACET2 env contract. These keys MUST be byte-
 * identical on the green and pool task defs.
 *
 *   FACET2_OMNI_GUARD=true       backstop tripwire in BomDispatcher: a
 *                                voxel-hostile class (SHELL/MICROSTRUCTURE/
 *                                ORGANIC) reaching the dispatcher throws
 *                                `voxel_hostile_class_requires_kernel` rather
 *                                than falling into the doomed voxel path. Stays
 *                                LOUD — never weakened to a warning.
 *   OMNI_MESH_ARTIFACTS_ROOT     mount point of the shared mesh store; OMNI's
 *                                MeshArtifactIngestor.Resolve() resolves each
 *                                part's mesh_ref (RELATIVE to this root) here.
 *   FluxTK__BaseUrl              see OMNI_FLUXTK_BASE_URL above.
 */
export const OMNI_FACET2_SHARED_ENV: Readonly<Record<string, string>> = {
  FACET2_OMNI_GUARD: 'true',
  OMNI_MESH_ARTIFACTS_ROOT: OMNI_MESH_ARTIFACTS_ROOT,
  FluxTK__BaseUrl: OMNI_FLUXTK_BASE_URL,
};

/**
 * Apply the shared FACET2 mesh wiring to an OMNI task definition + container +
 * task role: the read-only EFS volume, the read-only mount at
 * OMNI_MESH_ARTIFACTS_ROOT, and the matching read-only ClientMount grant.
 *
 * Both OMNI stacks call this with their own (taskDef, omni-api container,
 * taskRole) so the volume/mount/grant are generated from ONE definition and
 * cannot drift.
 *
 * No SG mutation is performed or required: both OMNI services run under the
 * SAME shared ECS task SG (networkStack.ecsSecurityGroup), and the EFS
 * mount-target SG already permits NFS:2049 from it self-referentially (the same
 * SG FACET2 writes with) — see PR #133. If a caller ever runs OMNI under a
 * DIFFERENT SG, the mount will fail at runtime and that MUST be surfaced loudly
 * (add the corresponding 2049 ingress) rather than silently skipped.
 */
export function applyOmniMeshContract(
  scope: cdk.Stack,
  taskDef: ecs.FargateTaskDefinition,
  container: ecs.ContainerDefinition,
  taskRole: iam.IRole,
): void {
  // Read-only EFS volume referencing the pre-existing FACET2 mesh store by
  // literal id (NOT an efs.FileSystem construct — see OMNI_MESH_EFS_* above).
  taskDef.addVolume({
    name: OMNI_MESH_VOLUME_NAME,
    efsVolumeConfiguration: {
      // rootDirectory omitted (defaults to '/'): with an access point set, ECS
      // requires rootDirectory be unset or '/'; the access point scopes the path.
      fileSystemId: OMNI_MESH_EFS_FILESYSTEM_ID,
      transitEncryption: 'ENABLED',
      authorizationConfig: {
        accessPointId: OMNI_MESH_EFS_ACCESS_POINT_ID,
        iam: 'ENABLED',
      },
    },
  });

  container.addMountPoints({
    sourceVolume: OMNI_MESH_VOLUME_NAME,
    containerPath: OMNI_MESH_ARTIFACTS_ROOT,
    readOnly: true,
  });

  // IAM-authorized mount (authorizationConfig.iam==='ENABLED') requires the
  // task role to hold elasticfilesystem:ClientMount on the mesh FS, gated on the
  // access point. Read-only: NO ClientWrite — FACET2 remains the sole writer.
  taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'OmniMeshStoreClientMountReadOnly',
    effect: iam.Effect.ALLOW,
    actions: ['elasticfilesystem:ClientMount'],
    resources: [
      `arn:aws:elasticfilesystem:${scope.region}:${scope.account}:file-system/${OMNI_MESH_EFS_FILESYSTEM_ID}`,
    ],
    conditions: {
      StringEquals: {
        'elasticfilesystem:AccessPointArn':
          `arn:aws:elasticfilesystem:${scope.region}:${scope.account}:access-point/${OMNI_MESH_EFS_ACCESS_POINT_ID}`,
      },
    },
  }));
}
