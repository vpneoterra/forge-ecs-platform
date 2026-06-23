/**
 * test/forge-omni-workflow-logs.test.ts
 *
 * Workflow-text regression guards for RC-2: the OMNI diagnostic & scale workflows
 * must read the SAME env-scoped CloudWatch log group the CDK creates, derived from
 * the `environment` input, and must FAIL LOUDLY (not swallow) when the resolved
 * group is missing.
 *
 * Pre-fix defects these lock out:
 *   - diagnose-omni.yml hardcoded an UNSCOPED `OMNI_LOG_GROUP: /forge/ecs/forge-omni`
 *     which does not exist for env=dev2 (the env that actually runs), yielding silent
 *     empty output while the job reports success.
 *   - scale-omni.yml read `/forge/dev/omni` (a path no stack creates) and hardcoded
 *     cluster `forge-app-dev`, so it produced empty logs and could not act on dev2.
 *
 * The green forge-omni log group is scoped() exactly like the CDK
 * (lib/forge-app-stack.ts:1092): legacyEnv (env==='dev') -> /forge/ecs/forge-omni,
 * else /forge/ecs/forge-omni-${env}. cluster is forge-app-${env}.
 */
import * as fs from 'fs';
import * as path from 'path';

function readWorkflow(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', name),
    'utf8',
  );
}

describe('RC-2 — diagnose-omni.yml derives the scoped OMNI log group', () => {
  const wf = readWorkflow('diagnose-omni.yml');

  test('no UNSCOPED static OMNI_LOG_GROUP: /forge/ecs/forge-omni assignment', () => {
    // The unscoped literal as a static env value is the defect (it never resolves
    // for non-dev envs). A scoped derivation may still mention the legacy-dev
    // literal inside an `if env == dev` branch, which is correct.
    expect(wf).not.toMatch(/^\s*OMNI_LOG_GROUP:\s*\/forge\/ecs\/forge-omni\s*$/m);
  });

  test('derives the scoped group from the environment input', () => {
    expect(wf).toMatch(/github\.event\.inputs\.environment/);
    expect(wf).toMatch(/\/forge\/ecs\/forge-omni-\$\{ENVIRONMENT\}/);
  });

  test('fails loudly (::error::) when the resolved log group is missing', () => {
    expect(wf).toMatch(/::error::/);
  });
});

describe('RC-2 — scale-omni.yml derives the scoped OMNI log group + cluster', () => {
  const wf = readWorkflow('scale-omni.yml');

  test('does not read the non-existent /forge/dev/omni log group', () => {
    expect(wf).not.toMatch(/\/forge\/dev\/omni/);
  });

  test('does not hardcode the forge-app-dev cluster', () => {
    expect(wf).not.toMatch(/forge-app-dev\b/);
  });

  test('takes an environment input and derives cluster + scoped group from it', () => {
    expect(wf).toMatch(/inputs:[\s\S]*environment:/);
    expect(wf).toMatch(/forge-app-\$\{ENVIRONMENT\}/);
    expect(wf).toMatch(/\/forge\/ecs\/forge-omni-\$\{ENVIRONMENT\}/);
  });

  test('fails loudly (::error::) when the resolved log group is missing', () => {
    expect(wf).toMatch(/::error::/);
  });
});
