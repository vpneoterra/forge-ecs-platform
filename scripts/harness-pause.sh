#!/usr/bin/env bash
# Pause/disable the tier-2 testing harness in response to a budget breach
# (USD 50 ceiling, see lib/forge-testing-harness-stack.ts).
#
# What this does, SCOPED STRICTLY TO HARNESS RESOURCES:
#   1. Sets the harness ECS service desiredCount to 0 (already the default,
#      but defensive if someone raised it).
#   2. Stops any RUNNING or PENDING tasks in the harness cluster.
#   3. Puts an ECR "lifecycle pause" in place by tagging the repo (no image
#      deletion -- just an audit trail tag).
#
# What this does NOT do:
#   - Touch OMNI, app, solver, data, or any other stack.
#   - Delete any infrastructure. A future `cdk deploy` restores normal state.
#
# Usage: ./scripts/harness-pause.sh [env]
set -euo pipefail

ENV_NAME="${1:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
CLUSTER_NAME="forge-testing-harness-${ENV_NAME}"
SERVICE_NAME="forge-testing-harness-${ENV_NAME}"
ECR_REPO="forge-testing-harness"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

info "Pausing harness in env=${ENV_NAME}, region=${REGION}"

info "1/3 forcing harness service desiredCount=0 ..."
aws ecs update-service \
  --cluster "${CLUSTER_NAME}" \
  --service "${SERVICE_NAME}" \
  --desired-count 0 \
  --region "${REGION}" >/dev/null && success "service set to 0"

info "2/3 stopping any RUNNING/PENDING harness tasks ..."
TASK_ARNS=$(aws ecs list-tasks \
  --cluster "${CLUSTER_NAME}" \
  --region "${REGION}" \
  --query 'taskArns[]' \
  --output text || true)

if [[ -n "${TASK_ARNS}" && "${TASK_ARNS}" != "None" ]]; then
  for arn in ${TASK_ARNS}; do
    info "   stopping ${arn##*/}"
    aws ecs stop-task \
      --cluster "${CLUSTER_NAME}" \
      --task "${arn}" \
      --reason "Harness paused: USD budget ceiling breached" \
      --region "${REGION}" >/dev/null || warn "stop-task failed for ${arn}"
  done
else
  info "   no active tasks"
fi
success "tasks stopped"

info "3/3 tagging ECR repo as paused (audit trail only) ..."
aws ecr tag-resource \
  --resource-arn "$(aws ecr describe-repositories \
      --repository-names "${ECR_REPO}" \
      --region "${REGION}" \
      --query 'repositories[0].repositoryArn' \
      --output text)" \
  --tags "Key=HarnessPaused,Value=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --region "${REGION}" >/dev/null || warn "tag-resource failed (non-fatal)"
success "ECR repo tagged"

info ""
success "Harness paused."
info "Re-enable by either:"
info "  a) running ./scripts/harness-run.sh ${ENV_NAME} (run-task ignores service desiredCount)"
info "  b) running cdk deploy ForgeTestingHarness-${ENV_NAME} to reset state"
