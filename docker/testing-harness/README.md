# FORGE Tier-2 Testing Harness Runner

Drives all **313 OMNI shape-chip JSONs** from
[`vpneoterra/forgenew`](https://github.com/vpneoterra/forgenew) at
`server/axiom/chips/shapes/<pack>/<name>.json` through the OMNI
tessellation/render endpoint and records per-chip pass/fail.

## Scope

- **Tier-2 only.** Chip → OMNI `/api/sdf/render` round-trip.
- **Not** a classifier evaluator. **Not** a param sweep. **Does not** use
  Anthropic or Voyage APIs. **Does not** deploy or mutate OMNI.

## OMNI endpoint

Source of truth: `forgenew/docker/omni/src/Api/SdfRenderEndpoint.cs`

```
POST /api/sdf/render
body: { "part": <BomPartJson>, "voxel_size_mm": float, "output_path": str }
```

The endpoint is gated by `#if SDF_ROUTER_ENABLED`, which
`penforge.csproj` defines — so the endpoint **is live** in the OMNI
container image as-built from that source.

If the route path ever moves, override `OMNI_RENDER_PATH` at run time
without a rebuild.

## Count guardrail

The runner **refuses to run** unless it discovers exactly
`EXPECTED_SHAPE_CHIP_COUNT` chip JSONs (default `313`). This is a
fail-closed guardrail against corpus drift.

## Local dry-run (no AWS)

```
docker build -t forge-testing-harness:dev docker/testing-harness/
docker run --rm \
  -e OMNI_BASE_URL=http://host.docker.internal:5000 \
  -e SHAPE_CORPUS_DIR=/corpus/shapes \
  -v $(pwd)/../forgenew/server/axiom/chips/shapes:/corpus/shapes:ro \
  forge-testing-harness:dev
```

## Production launch

See `scripts/harness-run.sh` at repo root.

## Budget auto-pause

The harness stack deploys an AWS Budget (USD 50 / month, scoped to
`CostCenter=forge-testing-harness`) with SNS notifications at 50/80/100%
and a Lambda (`forge-harness-auto-pause-<env>`) that is subscribed to
that SNS topic. When any threshold fires, the Lambda automatically:

1. sets the harness ECS service `desiredCount` to 0
2. stops any RUNNING / PENDING harness tasks

The Lambda is scoped strictly to the harness cluster/service via IAM;
it cannot touch OMNI, app, solver, or data stacks.

To opt out of auto-pause at synth time:

```
cdk deploy ForgeTestingHarness-dev \
  -c deployTestingHarness=true -c deployOmni=true \
  -c enableHarnessAutoPause=false
```

To disable an already-deployed Lambda without redeploying, set its
`AUTO_PAUSE_ENABLED` env var to `false` (it will log SNS events but
take no action). `scripts/harness-pause.sh` remains available as an
operator override in either case.
