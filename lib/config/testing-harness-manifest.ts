/**
 * FORGE Testing Harness Manifest (Tier-2 Shape Chip Validation)
 *
 * Scope:
 *   Drive all 313 OMNI shape-chip JSONs from vpneoterra/forgenew
 *   (server/axiom/chips/shapes/<pack>/<name>.json) through the OMNI
 *   tessellation/render endpoint and collect per-chip success/failure.
 *
 * Tier model:
 *   - Tier-1 (not in scope): chip-registry unit tests inside forgenew
 *   - Tier-2 (this harness):  end-to-end shape -> OMNI /api/sdf/render
 *   - Tier-3 (not in scope):  classifier eval, param sweep, Anthropic/Voyage
 *
 * OMNI endpoint source of truth (forgenew @ 2026-04-21):
 *   docker/omni/src/Api/SdfRenderEndpoint.cs
 *     POST /api/sdf/render         (single part)
 *     POST /api/sdf/batch-render   (array)
 *   Both are gated by #if SDF_ROUTER_ENABLED, which penforge.csproj defines.
 *   Health probe for readiness: GET /api/health (see ForgeOmniStack).
 *
 * Strict non-goals of this manifest:
 *   - No classifier-eval
 *   - No Anthropic / Voyage API keys or secrets
 *   - No tier-3 param sweep
 *   - No production data
 */

export const SHAPE_CHIP_EXPECTED_COUNT = 313;

/** Packs the 313 chips are distributed across, from forgenew/server/axiom/chips/shapes/ */
export const SHAPE_CHIP_PACKS: ReadonlyArray<string> = [
  'aerospace',
  'automotive',
  'civil',
  'consumer',
  'core',
  'defense',
  'electronics',
  'energy',
  'fluid_power',
  'marine',
  'medical',
  'process_chemical',
  'robotics',
];

export interface HarnessRunnerConfig {
  /** ECR repository name for the tier-2 harness runner image */
  ecrRepo: string;
  /** Fargate CPU units (1024 = 1 vCPU) */
  cpu: number;
  /** Fargate memory (MiB) */
  memory: number;
  /**
   * Configurable OMNI endpoint path. Default points at the confirmed route
   * in forgenew's SdfRenderEndpoint.cs. Override at run-time via the
   * OMNI_RENDER_PATH env var if the route is repositioned.
   */
  omniRenderPath: string;
  /** Health probe path on the OMNI ALB, used before batch submission */
  omniHealthPath: string;
  /** Per-part render timeout (seconds) */
  perPartTimeoutSec: number;
  /** Default voxel size (mm) passed to /api/sdf/render */
  defaultVoxelSizeMm: number;
  /** Maximum number of parts the runner will submit in a single harness invocation */
  maxPartsPerRun: number;
}

/**
 * Default runner config. Deliberately conservative — this harness is
 * authoring-only and must not incur cloud cost until an operator explicitly
 * deploys it and launches it.
 */
export const HARNESS_RUNNER: HarnessRunnerConfig = {
  ecrRepo: 'forge-testing-harness',
  cpu: 1024,
  memory: 2048,
  omniRenderPath: '/api/sdf/render',
  omniHealthPath: '/api/health',
  perPartTimeoutSec: 120,
  defaultVoxelSizeMm: 0.5,
  maxPartsPerRun: SHAPE_CHIP_EXPECTED_COUNT,
};

/**
 * USD cost ceiling for the tier-2 harness (and only the tier-2 harness).
 * Enforced at the AWS account level via an AWS Budget scoped to the
 * CostCenter=forge-testing-harness tag, with an SNS alarm at 80% and a
 * second alarm at 100% that triggers the pause script (see
 * scripts/harness-pause.sh).
 */
export const HARNESS_COST_CEILING_USD = 50;

/** Percent-of-budget thresholds that fire SNS notifications. */
export const HARNESS_BUDGET_THRESHOLDS_PERCENT: ReadonlyArray<number> = [50, 80, 100];

/** Shared tag key/value used for cost isolation of harness resources. */
export const HARNESS_COST_CENTER_TAG = {
  key: 'CostCenter',
  value: 'forge-testing-harness',
} as const;

/**
 * Auto-pause Lambda default. When true (the default), deploying the
 * harness stack also provisions a Lambda that is subscribed to the
 * harness SNS alert topic and will:
 *   - set the harness ECS service desiredCount to 0
 *   - stop any RUNNING / PENDING tasks in the harness cluster
 * as soon as AWS Budgets fires a threshold notification.
 *
 * The Lambda is scoped strictly to the harness cluster/service — it
 * cannot touch OMNI, app, solver, or data stacks. The operator
 * scripts/harness-pause.sh remains available as a manual override.
 *
 * Disable at synth time with `-c enableHarnessAutoPause=false`.
 */
export const HARNESS_AUTO_PAUSE_ENABLED_DEFAULT = true;
