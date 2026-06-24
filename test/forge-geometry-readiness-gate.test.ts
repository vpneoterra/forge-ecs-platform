/**
 * test/forge-geometry-readiness-gate.test.ts
 *
 * Workflow-text regression guards for RC-C: the geometry solver tier (FluxTK / SDF /
 * BREP) must not be able to fail silently.
 *
 * WHY THIS TEST EXISTS (RC-C)
 * ---------------------------
 * On run e26fb9d9 the geometry tier could not produce manifold geometry — FluxTK
 * Not Solved, 2% readiness, assembly_blocked_no_geometry — and the
 * `Build Geometry Container Images` workflow was failing for forge-brep /
 * forge-neural-sdf, yet nothing gated a deploy on solver health and nothing paged on
 * a broken geometry build. Two infra-owned fixes close that:
 *
 *   (a) deploy-app.yml gains a FluxTK readiness gate: when the solver is ENABLED
 *       (the forge-fluxtk ECS service exists with desiredCount>=1) but has ZERO
 *       running tasks, the deploy fails loudly (::error:: + exit 1) — it refuses to
 *       certify a "ready" pipeline on a dead solver. A dormant service (desired=0,
 *       the manifest default) or an undeployed geometry stack is a deliberate runbook
 *       state and is NOT gated.
 *
 *   (b) build-geometry-images.yml wires a failed build to the SAME forge-deploy-alerts
 *       SNS topic the OMNI liveness alarm (#137 RC-3) uses, so a broken geometry image
 *       pages instead of silently leaving FluxTK unsolved.
 *
 * NOTE (boundary, by design): FluxTK is Cloud-Map-internal only
 * (forge-fluxtk.forge-geometry.local:8040) with NO public/ALB ingress, so an HTTP
 * `/health` solver probe is not reachable from a CI runner — that variant is a
 * route-elsewhere (forgenew/app) follow-up. This repo gates on the reachable AWS-API
 * signal (ECS service running-task count), mirroring the RC-A OMNI target gate.
 *
 * These tests read workflow text only; they deploy nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

function readWorkflow(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', name),
    'utf8',
  );
}

describe('RC-C(a) — deploy-app.yml gates on FluxTK/geometry solver readiness', () => {
  const wf = readWorkflow('deploy-app.yml');

  test('references the forge-fluxtk geometry solver service', () => {
    expect(wf).toMatch(/forge-fluxtk/);
  });

  test('keys the gate on the solver being ENABLED (desiredCount) AND running tasks', () => {
    expect(wf).toMatch(/desiredCount|DESIRED/);
    expect(wf).toMatch(/runningCount|RUNNING/);
  });

  test('fails loudly (::error:: + exit 1) when an enabled solver has zero running tasks', () => {
    expect(wf).toMatch(/::error::[^\n]*FluxTK[\s\S]{0,500}exit 1/i);
  });

  test('does not swallow the geometry gate (no || true / || echo on the readiness query)', () => {
    expect(wf).not.toMatch(/runningCount[\s\S]{0,200}\|\|\s*(true|echo)/);
  });
});

describe('RC-C(b) — geometry build failure pages via forge-deploy-alerts SNS', () => {
  const wf = readWorkflow('build-geometry-images.yml');

  test('publishes to the forge-deploy-alerts SNS topic on build failure', () => {
    expect(wf).toMatch(/forge-deploy-alerts/);
    expect(wf).toMatch(/sns publish/);
  });

  test('the alert fires only on a non-success build result', () => {
    expect(wf).toMatch(/needs\.build\.result/);
    expect(wf).toMatch(/needs\.build\.result\s*!=\s*'success'|failure\(\)/);
  });
});
