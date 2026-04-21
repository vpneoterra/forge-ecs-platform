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
