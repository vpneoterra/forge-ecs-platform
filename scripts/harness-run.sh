#!/usr/bin/env bash
# Manually launch one tier-2 harness run (run-task, not a long-running service).
#
# Usage:  ./scripts/harness-run.sh [env]
#   env:  'dev' (default) | 'prod'
#
# Optional env vars (useful for smoke testing):
#   SMOKE_COUNT       If set to a positive integer, the run-task is submitted
#                     with container overrides MAX_PARTS_PER_RUN=<SMOKE_COUNT>
#                     and EXPECTED_SHAPE_CHIP_COUNT=<SMOKE_COUNT>. This lets
#                     you run only N chips (e.g. SMOKE_COUNT=3) without
#                     tripping the 313-chip count guardrail baked into the
#                     task definition.
#   WAIT_FOR_COMPLETION  If "true", block until the task reaches STOPPED and
#                     exit non-zero if the container exit code != 0.
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

RUN_ARGS=(
  ecs run-task
  --cluster "${CLUSTER_NAME}"
  --task-definition "${TASK_DEF_ARN}"
  --region "${REGION}"
  --launch-type FARGATE
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=DISABLED}"
  --count 1
  --output json
)

if [[ -n "${SMOKE_COUNT:-}" ]]; then
  if ! [[ "${SMOKE_COUNT}" =~ ^[0-9]+$ ]] || [[ "${SMOKE_COUNT}" -lt 1 ]]; then
    error "SMOKE_COUNT must be a positive integer (got: ${SMOKE_COUNT})"
    exit 1
  fi
  info "SMOKE_COUNT=${SMOKE_COUNT} -- adding container overrides for the runner"
  OVERRIDES=$(python3 -c "
import json, sys
n = sys.argv[1]
print(json.dumps({
    'containerOverrides': [{
        'name': 'harness-runner',
        'environment': [
            {'name': 'MAX_PARTS_PER_RUN',        'value': n},
            {'name': 'EXPECTED_SHAPE_CHIP_COUNT', 'value': n},
        ],
    }],
}))
" "${SMOKE_COUNT}")
  RUN_ARGS+=(--overrides "${OVERRIDES}")
fi

info "Submitting one-shot run-task ..."
RUN_JSON=$(aws "${RUN_ARGS[@]}")

TASK_ARN=$(echo "${RUN_JSON}" | python3 -c "import json,sys; print(json.load(sys.stdin)['tasks'][0]['taskArn'])")
TASK_ID="${TASK_ARN##*/}"
success "Task launched: ${TASK_ID}"
info "Tail logs with:"
info "  aws logs tail /forge/ecs/testing-harness --follow --region ${REGION}"
info ""
info "Inspect with:"
info "  aws ecs describe-tasks --cluster ${CLUSTER_NAME} --tasks ${TASK_ID} --region ${REGION}"

if [[ "${WAIT_FOR_COMPLETION:-false}" == "true" ]]; then
  info "Waiting for task ${TASK_ID} to reach STOPPED ..."
  aws ecs wait tasks-stopped \
    --cluster "${CLUSTER_NAME}" \
    --tasks "${TASK_ARN}" \
    --region "${REGION}"
  EXIT_CODE=$(aws ecs describe-tasks \
    --cluster "${CLUSTER_NAME}" \
    --tasks "${TASK_ARN}" \
    --region "${REGION}" \
    --query 'tasks[0].containers[?name==`harness-runner`].exitCode | [0]' \
    --output text)
  STOP_REASON=$(aws ecs describe-tasks \
    --cluster "${CLUSTER_NAME}" \
    --tasks "${TASK_ARN}" \
    --region "${REGION}" \
    --query 'tasks[0].stoppedReason' \
    --output text)
  info "Task stopped: exitCode=${EXIT_CODE} stoppedReason=${STOP_REASON}"
  if [[ "${EXIT_CODE}" != "0" ]]; then
    error "Harness task exited non-zero"
    exit 1
  fi
  success "Harness task completed cleanly"
fi
