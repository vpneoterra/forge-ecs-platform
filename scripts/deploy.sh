#!/usr/bin/env bash
# FORGE Platform — Local Deployment Script
# Usage: ./scripts/deploy.sh [dev|prod]
# Environment variables:
#   FORGE_ENV       Environment to deploy (default: dev)
#   BUILD_IMAGES    Set to "true" to also build and push Docker images
#   SKIP_RDS        Set to "true" to skip RDS (use external Supabase)
#   ALERT_EMAIL     Email for CloudWatch alerts (default: ops@forge.local)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
FORGE_ENV="${1:-${FORGE_ENV:-dev}}"
BUILD_IMAGES="${BUILD_IMAGES:-false}"
SKIP_RDS="${SKIP_RDS:-false}"
ALERT_EMAIL="${ALERT_EMAIL:-ops@forge.local}"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        FORGE ECS Platform Deployment             ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Environment : ${FORGE_ENV}"
info "Skip RDS    : ${SKIP_RDS}"
info "Alert email : ${ALERT_EMAIL}"
info "Build images: ${BUILD_IMAGES}"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v aws >/dev/null 2>&1    || die "AWS CLI not found. Install: https://aws.amazon.com/cli/"
command -v node >/dev/null 2>&1   || die "Node.js not found. Install: https://nodejs.org/"
command -v npm >/dev/null 2>&1    || die "npm not found."

if [[ "${BUILD_IMAGES}" == "true" ]]; then
  command -v docker >/dev/null 2>&1 || die "Docker required for BUILD_IMAGES=true"
fi

# Check CDK
if ! command -v cdk >/dev/null 2>&1; then
  warn "CDK CLI not found — installing globally..."
  npm install -g aws-cdk
fi

success "Prerequisites OK"

# ── AWS Identity ──────────────────────────────────────────────────────────────
info "Verifying AWS credentials..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die "AWS credentials not configured. Run: aws configure"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

success "AWS Account: ${ACCOUNT_ID} | Region: ${REGION}"

# ── Install dependencies ──────────────────────────────────────────────────────
cd "${REPO_ROOT}"
info "Installing npm dependencies..."
npm ci
success "Dependencies installed"

# ── TypeScript compile check ──────────────────────────────────────────────────
info "Type-checking TypeScript..."
npx tsc --noEmit && success "TypeScript OK" || die "TypeScript compile errors — fix before deploying"

# ── Phase 1: CDK Bootstrap ────────────────────────────────────────────────────
echo ""
info "Phase 1/4: CDK Bootstrap..."
npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" \
  --cloudformation-execution-policies 'arn:aws:iam::aws:policy/AdministratorAccess' \
  2>&1 | grep -v "^Waiting" || true
success "Bootstrap complete"

# ── Phase 2: Deploy infrastructure ───────────────────────────────────────────
echo ""
info "Phase 2/4: Deploying stacks (this takes ~10 minutes on first run)..."

DEPLOY_ARGS=(
  "--all"
  "--require-approval" "never"
  "--outputs-file" "cdk-outputs.json"
  "-c" "env=${FORGE_ENV}"
  "-c" "skipRds=${SKIP_RDS}"
  "-c" "alertEmail=${ALERT_EMAIL}"
)

npx cdk deploy "${DEPLOY_ARGS[@]}"

success "All stacks deployed"

# ── Show outputs ──────────────────────────────────────────────────────────────
if [[ -f "cdk-outputs.json" ]]; then
  echo ""
  info "=== Stack Outputs ==="
  python3 -m json.tool cdk-outputs.json 2>/dev/null || cat cdk-outputs.json
fi

# ── Phase 3: Build images (optional) ─────────────────────────────────────────
if [[ "${BUILD_IMAGES}" == "true" ]]; then
  echo ""
  info "Phase 3/4: Building and pushing Docker images..."
  "${SCRIPT_DIR}/docker/build-all.sh"
  success "Images built and pushed"
else
  warn "Phase 3/4: Skipping image build (BUILD_IMAGES=${BUILD_IMAGES})"
  warn "Run BUILD_IMAGES=true ./scripts/deploy.sh to also build images"
fi

# ── Phase 4: Smoke test ───────────────────────────────────────────────────────
echo ""
info "Phase 4/4: Smoke test..."

CLUSTER_NAME=$(python3 -c "
import json, sys
try:
    with open('cdk-outputs.json') as f:
        data = json.load(f)
    for stack, outputs in data.items():
        if 'ClusterName' in outputs:
            print(outputs['ClusterName'])
            break
except: pass
" 2>/dev/null || echo "")

if [[ -n "${CLUSTER_NAME}" ]]; then
  info "Waiting for ECS services to stabilize in ${CLUSTER_NAME}..."
  aws ecs wait services-stable \
    --cluster "${CLUSTER_NAME}" \
    --services forge-lightweight forge-devops forge-monitoring \
    --region "${REGION}" 2>/dev/null \
    && success "ECS services stable" \
    || warn "Services not yet stable — may still be starting (check ECS console)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        Deployment Complete!                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Next steps:"
echo "  • Check ECS console: https://${REGION}.console.aws.amazon.com/ecs/home?region=${REGION}#/clusters"
echo "  • Monitor costs: https://console.aws.amazon.com/billing/home"
echo "  • To hibernate (save costs): ./scripts/hibernate.sh"
echo "  • To wake up:               ./scripts/wake.sh"
echo ""
