# PicoGK 2.1 → ECS Cutover Protocol

Replaces the off-cluster Hetzner PicoGK endpoint (`89.167.79.141:8015`) with an
in-cluster Fargate service at `forge-picogk.forge-geometry.local:8015`.

**Do not execute any step without explicit user approval.** This document is the
runbook only.

## Preconditions

- `vpneoterra/forgenew` PR `feat/picogk-2.1-ecs` is merged.
- `vpneoterra/forge-ecs-platform` PR `feat/picogk-2.1-ecs` is merged.
- The validation harness under `/home/user/workspace/validation/` has been
  exercised against a locally built image and `REPORT.md` shows green on all
  acceptance gates from DESIGN_BRIEF §6 (core gate, port lint, Stage-1 `.so`
  with `26.1` in `strings`, `/health`, `/capabilities`, contract diff, golden
  gyroid within ±5%, AXIOM round-trip).

## Steps

1. **Image build.** Merge the `forgenew` PR. The
   `.github/workflows/build-geometry-images.yml` matrix job `forge-picogk`
   pushes `:latest`, a `:YYYYMMDD-HHMMSS` tag, and a `:<sha>` tag to ECR
   repository `forge-picogk`.

2. **CDK deploy.** Merge the `forge-ecs-platform` PR and run
   `cdk deploy --all` (or the project's normal deploy path). This creates the
   ECR repo via the `CONTAINER_CAPABILITIES` loop in
   `lib/forge-geometry-stack.ts`, the Fargate task definition `forge-picogk`,
   and the service `forge-picogk` in cluster `forge-geometry-<env>`. The
   service is created with `desiredCount: 0` by the shared
   `createFargateService` helper even though `CAP_PICOGK.activateOnDeploy =
   true` — the operator scales it up explicitly in the next step so the cutover
   is deliberate, not a side-effect of the deploy.

3. **Scale to 1.** Operator runs

   ```bash
   aws ecs update-service \
     --cluster forge-geometry-<env> \
     --service forge-picogk \
     --desired-count 1
   ```

   Wait for the task to reach `RUNNING` and the target health check to pass.
   Verify `/health` returns 200 from inside the VPC (e.g. via an
   `aws ecs execute-command` session into another container in the same SG):

   ```bash
   curl -sf http://forge-picogk.forge-geometry.local:8015/health
   ```

4. **In-VPC validation.** From inside the VPC, run the validation harness
   against `http://forge-picogk.forge-geometry.local:8015`:

   - `GET /capabilities` — lists the seven TPMS types and three implicit
     types verbatim from the Python shim.
   - `POST /generate/tpms` with a unit-cell gyroid — triangle count within
     ±5% of the 1.7.7.5 golden, bbox within ±1 voxel, volume within ±5%.
   - Contract diff vs. `forgenew/docker/picogk/api_wrapper.py` keys for every
     route.

   Any failure here aborts the cutover; scale back to 0 and roll forward in
   `forgenew`.

5. **Roll forge-app.** With `forge-picogk` healthy, redeploy `forge-app` so it
   picks up the new `PICOGK_API_URL` from `CAP_PICOGK.appEnvVars`
   (`http://forge-picogk.forge-geometry.local:8015`). The literal
   `http://89.167.79.141:8015` is gone from `lib/forge-app-stack.ts` as of the
   merged PR; the env var now resolves to Cloud Map DNS.

6. **Soak.** Watch Hetzner ingress traffic at `89.167.79.141:8015` for ≥24h.
   When it reaches zero and stays there, decommission the Hetzner host. Do
   **not** silence the Hetzner endpoint or change its DNS during the soak —
   the goal is a clean traffic drop as proof, not a forced cutover.

## Rollback

If `/health` flaps, contract diff fails, or forge-app starts erroring against
the new endpoint:

1. `aws ecs update-service --cluster forge-geometry-<env> --service forge-picogk --desired-count 0`
2. Temporarily override `PICOGK_API_URL=http://89.167.79.141:8015` on the
   `forge-app-test` task definition via the AWS console (or a hot patch
   workflow) and force a new deployment.
3. File a follow-up PR to revert `CAP_PICOGK.appEnvVars.PICOGK_API_URL` to
   the Hetzner literal if the rollback needs to outlast a single deploy.

The legacy Python shim source remains under `forgenew/docker/picogk/legacy/`
for reference during rollback investigation.
