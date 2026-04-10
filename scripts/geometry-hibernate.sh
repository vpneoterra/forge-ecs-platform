#!/usr/bin/env bash
# FORGE Geometry — Hibernate Script
# Stops the forge-brep service in the geometry cluster (forge-geometry-${FORGE_ENV}).
#
# GPU task definitions (e.g. mesh repair, tessellation) have no permanently running
# services — they are launched on-demand — so no action is needed for those here.
#
# ASG Editor and Field-Driven TPMS are client-side only; disable them by toggling
# the appropriate feature flags in the forge-app environment variables.
#
# Usage: FORGE_ENV=dev ./scripts/geometry-hibernate.sh
set -euo pipefail

FORGE_ENV="${FORGE_ENV:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║   FORGE Geometry — Entering Hibernate Mode       ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════╝${NC}"
echo ""

CLUSTER="forge-geometry-${FORGE_ENV}"

# ── 1. Scale forge-brep service to 0 ──────────────────────────────────────────
info "Scaling forge-brep to desiredCount=0 in cluster ${CLUSTER}..."
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service forge-brep \
  --desired-count 0 \
  --region "${REGION}" \
  --output text --query 'service.serviceName' 2>/dev/null \
  && success "Scaled down: forge-brep" \
  || warn "Service not found: forge-brep (may already be stopped)"

# ── 2. GPU services — no action needed ────────────────────────────────────────
info "GPU task definitions (mesh repair, tessellation, etc.) have no running services"
info "by default — they are launched on-demand via SQS. No action needed."

# ── 3. Client-side features — flag reminder ───────────────────────────────────
echo ""
warn "ASG Editor and Field-Driven TPMS are client-side only."
warn "To disable them, set the appropriate feature flags in the forge-app"
warn "environment variables (e.g. BREP_ENGINE_ENABLED=false) and redeploy"
warn "or restart the forge-app service."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Geometry Hibernate Complete                    ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "To resume: FORGE_ENV=${FORGE_ENV} ./scripts/geometry-wake.sh"
echo ""
