#!/usr/bin/env bash
# Manually launch one tier-2 harness run (run-task, not a long-running service).
#
# Usage:  ./scripts/harness-run.sh [env]
#   env:  'dev' (default) | 'prod'
#
# Prereqs:
#   - ForgeTestingHarness-<env> stack deployed
#     (`cdk deploy ForgeTestingHarness-<env> -c deployTestingHarness=true -c deployOmni=true`)
#   - Runner image pushed (./scripts/harness-build.sh <env>)
#   - OMNI ALB reachable at the URL configured in ForgeOmniStack
#
# This script does NOT create cloud resources. It submits one ECS run-task
# against the already-deployed cluster/taskdef and then tails its logs.
set -euo pipefail

ENV_NAME="${1:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
STACK_NAME="ForgeTestingHarness-${ENV_NAME}"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

info "Resolving stack outputs for ${STACK_NAME} ..."
OUTPUTS_JSON=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query 'Stacks[0].Outputs' \
  --output json)

get_output() {
  echo "${OUTPUTS_JSON}" | python3 -c "
import json, sys
want = sys.argv[1]
for o in json.load(sys.stdin):
    if o['OutputKey'] == want:
        print(o['OutputValue']); sys.exit(0)
sys.exit(1)
" "$1"
}

CLUSTER_NAME=$(get_output HarnessClusterName) || { error "missing HarnessClusterName output"; exit 1; }
TASK_DEF_ARN=$(get_output HarnessTaskDefArn)  || { error "missing HarnessTaskDefArn output";  exit 1; }

info "Cluster:  ${CLUSTER_NAME}"
info "TaskDef:  ${TASK_DEF_ARN}"

# Resolve the private subnets and security group from the OMNI stack's VPC
# using the forge-testing-harness service's network config (CDK already baked
# it into the task / service definition).
info "Reading service network config ..."
SERVICE_NAME="forge-testing-harness-${ENV_NAME}"
NET_JSON=$(aws ecs describe-services \
  --cluster "${CLUSTER_NAME}" \
  --services "${SERVICE_NAME}" \
  --region "${REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json)

if [[ -z "${NET_JSON}" || "${NET_JSON}" == "null" ]]; then
  error "Could not load network config from service ${SERVICE_NAME}."
  error "Is the stack deployed and the service present?"
  exit 1
fi

SUBNETS=$(echo "${NET_JSON}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d['subnets']))")
SG=$(echo "${NET_JSON}"      | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(d['securityGroups']))")

info "Submitting one-shot run-task ..."
RUN_JSON=$(aws ecs run-task \
  --cluster "${CLUSTER_NAME}" \
  --task-definition "${TASK_DEF_ARN}" \
  --region "${REGION}" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=DISABLED}" \
  --count 1 \
  --output json)

TASK_ARN=$(echo "${RUN_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)['tasks'][0]['taskArn'])")
TASK_ID="${TASK_ARN##*/}"
success "Task launched: ${TASK_ID}"
info "Tail logs with:"
info "  aws logs tail /forge/ecs/testing-harness --follow --region ${REGION}"
info ""
info "Inspect with:"
info "  aws ecs describe-tasks --cluster ${CLUSTER_NAME} --tasks ${TASK_ID} --region ${REGION}"
