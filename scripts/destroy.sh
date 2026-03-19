#!/usr/bin/env bash
# FORGE Platform — Teardown Script
# Destroys ALL CloudFormation stacks and resources.
# WARNING: This deletes everything except S3 bucket and RDS (RetainPolicy).
# Usage: ./scripts/destroy.sh [dev|prod]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FORGE_ENV="${1:-${FORGE_ENV:-dev}}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }

echo ""
echo -e "${RED}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║   FORGE Platform DESTROY — Environment: ${FORGE_ENV}    ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════════╝${NC}"
echo ""
warn "This will destroy ALL infrastructure in the ${FORGE_ENV} environment."
warn "S3 bucket and RDS have RetainPolicy — they must be deleted manually."
echo ""

# Confirm
read -r -p "Type 'destroy ${FORGE_ENV}' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "destroy ${FORGE_ENV}" ]]; then
  echo "Aborted."
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
info "Account: ${ACCOUNT_ID} | Region: ${REGION} | Environment: ${FORGE_ENV}"

cd "${REPO_ROOT}"
npm ci --quiet

# Stop all ECS services first (scale to 0) to avoid ECS service dependency issues
info "Scaling ECS services to 0 before destroy..."
CLUSTER="forge-${FORGE_ENV}"
for SERVICE in forge-lightweight forge-devops forge-monitoring; do
  aws ecs update-service \
    --cluster "${CLUSTER}" \
    --service "${SERVICE}" \
    --desired-count 0 \
    --region "${REGION}" 2>/dev/null || true
done

# Wait a moment for tasks to drain
info "Waiting 30s for tasks to drain..."
sleep 30

# CDK destroy — reverse order
info "Destroying stacks..."
npx cdk destroy --all --force -c env="${FORGE_ENV}"

echo ""
echo -e "${GREEN}Destroy complete.${NC}"
echo ""
warn "RETAINED resources (must delete manually to stop all billing):"
echo "  • S3: forge-platform-data-${ACCOUNT_ID}-${REGION}"
echo "  • RDS: check AWS RDS console (if deployed)"
echo "  • ECR repositories: forge-* (small storage cost)"
echo "  • EFS: check AWS EFS console"
echo ""
