#!/usr/bin/env bash
# FORGE Geometry — Wake Script
# Brings the forge-brep and forge-fluxtk services back online in the geometry
# cluster (forge-geometry-${FORGE_ENV}) and waits for them to stabilize.
#
# GPU capabilities (mesh repair, tessellation, etc.) run as on-demand tasks on
# the solver cluster (Provider C). See the commented-out section at the bottom
# of this script for instructions on creating and running GPU services manually.
#
# Usage: FORGE_ENV=dev ./scripts/geometry-wake.sh
set -euo pipefail

FORGE_ENV="${FORGE_ENV:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

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

# ── 1. Scale forge-brep service to 1 ──────────────────────────────────────────
info "Scaling forge-brep to desiredCount=1 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service forge-brep \
  --desired-count 1 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Service resumed: forge-brep" \
  || warn "Service not found: forge-brep"

# ── 2. Scale forge-fluxtk service to 1 ───────────────────────────────────────
info "Scaling forge-fluxtk to desiredCount=1 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service forge-fluxtk \
  --desired-count 1 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Service resumed: forge-fluxtk" \
  || warn "Service not found: forge-fluxtk"

# ── 3. Wait for services to stabilize ────────────────────────────────────────
info "Waiting for forge-brep and forge-fluxtk to stabilize (up to 10 minutes)..."
aws ecs wait services-stable \
  --cluster "${CLUSTER}" \
  --services forge-brep forge-fluxtk \
  --region "${REGION}" 2>/dev/null \
  && success "forge-brep and forge-fluxtk are stable" \
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
echo ""
info "Services now running:"
echo "  • forge-brep    — B-Rep geometry engine (OCCT / custom BREP solver)"
echo "  • forge-fluxtk  — FluxTK / BRAIDE conservation network solver"
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
