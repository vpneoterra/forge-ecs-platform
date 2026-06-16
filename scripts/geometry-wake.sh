#!/usr/bin/env bash
# FORGE Geometry — Wake Script
# Brings the forge-picogk, forge-brep and forge-fluxtk services back online in
# the geometry cluster (forge-geometry-${FORGE_ENV}) and waits for them to
# stabilize.
#
# Service names are env-scoped to match the CDK `scoped()` helper in
# lib/forge-geometry-stack.ts: the legacy 'dev' (blue) env uses bare names
# (forge-picogk), while any other env (e.g. 'dev2' / green) uses an env-suffixed
# name (forge-picogk-dev2). Running this script against the wrong env name was
# previously a silent no-op ("Service not found").
#
# GPU capabilities (mesh repair, tessellation, etc.) run as on-demand tasks on
# the solver cluster (Provider C). See the commented-out section at the bottom
# of this script for instructions on creating and running GPU services manually.
#
# Usage: FORGE_ENV=dev ./scripts/geometry-wake.sh
#        FORGE_ENV=dev2 ./scripts/geometry-wake.sh
set -euo pipefail

FORGE_ENV="${FORGE_ENV:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

# Env-scoped service name: legacy 'dev' keeps the bare name; every other env
# gets an env suffix (mirrors lib/forge-geometry-stack.ts `scoped()`).
scoped() {
  if [ "${FORGE_ENV}" = "dev" ]; then echo "$1"; else echo "$1-${FORGE_ENV}"; fi
}

SVC_PICOGK="$(scoped forge-picogk)"
SVC_BREP="$(scoped forge-brep)"
SVC_FLUXTK="$(scoped forge-fluxtk)"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   FORGE Geometry — Waking Up                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

CLUSTER="forge-geometry-${FORGE_ENV}"
info "Cluster: ${CLUSTER}  (env=${FORGE_ENV})"
info "Services: ${SVC_PICOGK}, ${SVC_BREP}, ${SVC_FLUXTK}"

# ── 1. Scale forge-picogk service to 1 ────────────────────────────────────────
# PicoGK is the voxel geometry kernel (CAP_PICOGK.activateOnDeploy=true). It is
# the backend that omni / Maestro reach for networked mesh generation; without a
# running task its Cloud Map A-record set is empty and callers see a DNS
# resolution failure ("Name or service not known").
info "Scaling ${SVC_PICOGK} to desiredCount=1 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service "${SVC_PICOGK}" \
  --desired-count 1 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Service resumed: ${SVC_PICOGK}" \
  || warn "Service not found: ${SVC_PICOGK}"

# ── 2. Scale forge-brep service to 1 ──────────────────────────────────────────
info "Scaling ${SVC_BREP} to desiredCount=1 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service "${SVC_BREP}" \
  --desired-count 1 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Service resumed: ${SVC_BREP}" \
  || warn "Service not found: ${SVC_BREP}"

# ── 3. Scale forge-fluxtk service to 1 ───────────────────────────────────────
info "Scaling ${SVC_FLUXTK} to desiredCount=1 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service "${SVC_FLUXTK}" \
  --desired-count 1 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Service resumed: ${SVC_FLUXTK}" \
  || warn "Service not found: ${SVC_FLUXTK}"

# ── 4. Wait for services to stabilize ────────────────────────────────────────
info "Waiting for ${SVC_PICOGK}, ${SVC_BREP} and ${SVC_FLUXTK} to stabilize (up to 10 minutes)..."
aws ecs wait services-stable \
  --cluster "${CLUSTER}" \
  --services "${SVC_PICOGK}" "${SVC_BREP}" "${SVC_FLUXTK}" \
  --region "${REGION}" 2>/dev/null \
  && success "${SVC_PICOGK}, ${SVC_BREP} and ${SVC_FLUXTK} are stable" \
  || warn "Services not yet stable — check ECS console in a few minutes"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   FORGE Geometry is awake!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
warn "Remember to set feature flags in forge-app env and restart:"
warn "  BREP_ENGINE_ENABLED=true"
warn "  FLUXTK_ENABLED=true"
warn "  PICOGK_ENABLED=true (default true)"
echo ""
info "Services now running:"
echo "  • ${SVC_PICOGK}  — PicoGK 2.1 voxel geometry kernel (lattices, booleans, TPMS)"
echo "  • ${SVC_BREP}    — B-Rep geometry engine (OCCT / custom BREP solver)"
echo "  • ${SVC_FLUXTK}  — FluxTK / BRAIDE conservation network solver"
echo ""
info "GPU capabilities (on-demand, Provider C): see commented section below"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# GPU CAPABILITIES — On-Demand via Provider C (Solver Cluster)
# ──────────────────────────────────────────────────────────────────────────────
#
# GPU tasks (mesh repair, Boolean ops, tessellation) are NOT persistent services.
# They are run as standalone ECS tasks on the solver cluster backed by Provider C
# (GPU-enabled ASG with g4dn / g5 instances). The ASG scales to 0 when idle.
#
# To run a GPU task manually:
#
#   SOLVER_CLUSTER="forge-solver-${FORGE_ENV}"
#
#   # 1. Ensure Provider C ASG has capacity (set min/desired to 1):
#   #    aws autoscaling update-auto-scaling-group \
#   #      --auto-scaling-group-name <ForgeProviderC-asg-name> \
#   #      --min-size 1 --desired-capacity 1 \
#   #      --region "${REGION}"
#
#   # 2. Run the GPU task:
#   #    aws ecs run-task \
#   #      --cluster "${SOLVER_CLUSTER}" \
#   #      --task-definition forge-mesh-repair:LATEST \
#   #      --capacity-provider-strategy capacityProvider=ForgeProviderC,weight=1 \
#   #      --network-configuration "awsvpcConfiguration={subnets=[<subnet-id>],securityGroups=[<sg-id>]}" \
#   #      --overrides '{"containerOverrides":[{"name":"forge-mesh-repair","environment":[{"name":"INPUT_S3_KEY","value":"<key>"}]}]}' \
#   #      --region "${REGION}"
#
#   # 3. To create a GPU service (long-running, e.g. for high-throughput periods):
#   #    aws ecs create-service \
#   #      --cluster "${SOLVER_CLUSTER}" \
#   #      --service-name forge-mesh-repair \
#   #      --task-definition forge-mesh-repair:LATEST \
#   #      --desired-count 1 \
#   #      --capacity-provider-strategy capacityProvider=ForgeProviderC,weight=1 \
#   #      --network-configuration "awsvpcConfiguration={subnets=[<subnet-id>],securityGroups=[<sg-id>],assignPublicIp=DISABLED}" \
#   #      --region "${REGION}"
#   #
#   #    # Scale back to 0 when done:
#   #    aws ecs update-service \
#   #      --cluster "${SOLVER_CLUSTER}" \
#   #      --service forge-mesh-repair \
#   #      --desired-count 0 \
#   #      --region "${REGION}"
#
# NOTE: Provider C ASG will scale back to 0 automatically when no tasks are running
#       if ECS managed scaling is configured. Otherwise scale it down manually to
#       avoid idle GPU instance costs (~$0.526/hr for g4dn.xlarge).
# ──────────────────────────────────────────────────────────────────────────────
