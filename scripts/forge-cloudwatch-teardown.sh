#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# FORGE — CloudWatch Monitoring Teardown
# Removes all resources created by forge-cloudwatch-setup.sh
#
# Usage:
#   chmod +x forge-cloudwatch-teardown.sh
#   ./forge-cloudwatch-teardown.sh [--dry-run]
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

REGION="us-east-1"
LOG_GROUP_APP="/forge/ecs/forge-app-test"
NAMESPACE="FORGE/Platform"

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

run_cmd() {
  if [ "$DRY_RUN" = true ]; then echo "[DRY-RUN] $*"; else echo "[EXEC] $*"; eval "$@" || true; fi
}

echo "Removing metric filters..."
for f in forge-i2d-run-start forge-claude-errors forge-i2d-phase-failure forge-app-errors forge-s3-flush forge-meridian-events; do
  run_cmd "aws logs delete-metric-filter --region ${REGION} --log-group-name ${LOG_GROUP_APP} --filter-name ${f}"
done

echo "Removing alarms..."
run_cmd "aws cloudwatch delete-alarms --region ${REGION} --alarm-names forge-i2d-phase-failure forge-claude-api-errors forge-s3-flush-stalled"

echo "Removing dashboard..."
run_cmd "aws cloudwatch delete-dashboards --region ${REGION} --dashboard-names FORGE-Unified"

echo "Removing saved queries..."
for q in $(aws logs describe-query-definitions --region ${REGION} --query-definition-name-prefix FORGE --query 'queryDefinitions[].queryDefinitionId' --output text 2>/dev/null); do
  run_cmd "aws logs delete-query-definition --region ${REGION} --query-definition-id ${q}"
done

echo "Removing EventBridge rule..."
run_cmd "aws events remove-targets --region ${REGION} --rule forge-s3-design-files --ids 1 2>/dev/null"
run_cmd "aws events delete-rule --region ${REGION} --name forge-s3-design-files"

echo ""
echo "Done. Log retention and S3 lifecycle policies NOT removed (safe to keep)."
