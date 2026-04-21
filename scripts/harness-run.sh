#!/usr/bin/env bash
# Manually launch one tier-2 harness run (run-task, not a long-running service).
#
# Usage:  ./scripts/harness-run.sh [env]
#   env:  'dev' (default) | 'prod'
#
# Optional env vars (useful for smoke testing):
#   SMOKE_COUNT       If set to a positive integer and RUN_LIMIT is unset,
#                     the run-task is submitted with a container override
#                     MAX_PARTS_PER_RUN=<SMOKE_COUNT>, limiting execution to N
#                     chips (e.g. SMOKE_COUNT=3) while
#                     still validating that the full baked corpus of 313 chips
#                     is present. EXPECTED_SHAPE_CHIP_COUNT is intentionally
#                     NOT overridden here: the count guardrail must continue
#                     to assert the full corpus exists even during smoke runs.
#   RUN_LIMIT         If set to a positive integer, override MAX_PARTS_PER_RUN.
#                     Use RUN_LIMIT=313 for the full sequential run.
#   EXPECTED_SHAPE_CHIP_COUNT
#                     If set to a positive integer, override the corpus count
#                     guard. Shape Check sets this dynamically so the same
#                     harness image/process can validate 313 now and 1000+
#                     later without code changes.
#   SHAPE_START_INDEX Zero-based index into the deterministic corpus order.
#   STOP_ON_FAILURE   If true, the runner stops after the first failed chip.
#   DEFAULT_VOXEL_SIZE_MM, PER_PART_TIMEOUT_SEC, VOXEL_BUDGET_RETRY,
#   VOXEL_SIZE_SAFETY_MULT, MAX_VOXEL_SIZE_MM
#                     Optional runner tuning overrides.
#   LOG_EVENT_LIMIT   Number of CloudWatch log events to dump after STOPPED
#                     when WAIT_FOR_COMPLETION=true (default: 200).
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

RUN_MAX="${RUN_LIMIT:-${SMOKE_COUNT:-}}"
if [[ -n "${RUN_MAX}" ]]; then
  if ! [[ "${RUN_MAX}" =~ ^[0-9]+$ ]] || [[ "${RUN_MAX}" -lt 1 ]]; then
    error "RUN_LIMIT/SMOKE_COUNT must be a positive integer (got: ${RUN_MAX})"
    exit 1
  fi
  if [[ -n "${RUN_LIMIT:-}" ]]; then
    info "RUN_LIMIT=${RUN_LIMIT} -- limiting run to ${RUN_LIMIT} chips (corpus guard still expects 313)"
  else
    info "SMOKE_COUNT=${SMOKE_COUNT} -- limiting run to ${SMOKE_COUNT} chips (corpus guard still expects 313)"
  fi
fi

if [[ -n "${SHAPE_START_INDEX:-}" ]]; then
  if ! [[ "${SHAPE_START_INDEX}" =~ ^[0-9]+$ ]]; then
    error "SHAPE_START_INDEX must be a non-negative integer (got: ${SHAPE_START_INDEX})"
    exit 1
  fi
fi

if [[ -n "${RUN_MAX}" || -n "${EXPECTED_SHAPE_CHIP_COUNT:-}" || -n "${SHAPE_START_INDEX:-}" || -n "${STOP_ON_FAILURE:-}" || -n "${DEFAULT_VOXEL_SIZE_MM:-}" || -n "${PER_PART_TIMEOUT_SEC:-}" || -n "${VOXEL_BUDGET_RETRY:-}" || -n "${VOXEL_SIZE_SAFETY_MULT:-}" || -n "${MAX_VOXEL_SIZE_MM:-}" ]]; then
  # Only override MAX_PARTS_PER_RUN. EXPECTED_SHAPE_CHIP_COUNT remains at the
  # task-def default (313) so the runner's fail-closed count guardrail still
  # verifies the full baked corpus is present before executing N parts.
  OVERRIDES=$(python3 -c "import json, sys
limit, expected_count, start, stop, default_voxel, timeout_sec, voxel_retry, mult, max_voxel = sys.argv[1:]
env = []
if limit:
    env.append({'name': 'MAX_PARTS_PER_RUN', 'value': limit})
if expected_count:
    env.append({'name': 'EXPECTED_SHAPE_CHIP_COUNT', 'value': expected_count})
if start:
    env.append({'name': 'SHAPE_START_INDEX', 'value': start})
if stop:
    env.append({'name': 'STOP_ON_FAILURE', 'value': stop})
if default_voxel:
    env.append({'name': 'DEFAULT_VOXEL_SIZE_MM', 'value': default_voxel})
if timeout_sec:
    env.append({'name': 'PER_PART_TIMEOUT_SEC', 'value': timeout_sec})
if voxel_retry:
    env.append({'name': 'VOXEL_BUDGET_RETRY', 'value': voxel_retry})
if mult:
    env.append({'name': 'VOXEL_SIZE_SAFETY_MULT', 'value': mult})
if max_voxel:
    env.append({'name': 'MAX_VOXEL_SIZE_MM', 'value': max_voxel})
print(json.dumps({
    'containerOverrides': [{
        'name': 'harness-runner',
        'environment': env,
    }],
}))" "${RUN_MAX}" "${EXPECTED_SHAPE_CHIP_COUNT:-}" "${SHAPE_START_INDEX:-}" "${STOP_ON_FAILURE:-}" "${DEFAULT_VOXEL_SIZE_MM:-}" "${PER_PART_TIMEOUT_SEC:-}" "${VOXEL_BUDGET_RETRY:-}" "${VOXEL_SIZE_SAFETY_MULT:-}" "${MAX_VOXEL_SIZE_MM:-}")
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

  # Full task description (best-effort, non-fatal).
  DESCRIBE_JSON=$(aws ecs describe-tasks \
    --cluster "${CLUSTER_NAME}" \
    --tasks "${TASK_ARN}" \
    --region "${REGION}" \
    --output json 2>/dev/null || echo '{}')

  info "=== ECS task summary (${TASK_ID}) ==="
  echo "${DESCRIBE_JSON}" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    t = (d.get('tasks') or [{}])[0]
    print(f\"lastStatus    : {t.get('lastStatus')}\")
    print(f\"stopCode      : {t.get('stopCode')}\")
    print(f\"stoppedReason : {t.get('stoppedReason')}\")
    print(f\"taskDefArn    : {t.get('taskDefinitionArn')}\")
    for c in t.get('containers', []) or []:
        print('---')
        print(f\"  container   : {c.get('name')}\")
        print(f\"  image       : {c.get('image')}\")
        print(f\"  lastStatus  : {c.get('lastStatus')}\")
        print(f\"  exitCode    : {c.get('exitCode')}\")
        print(f\"  reason      : {c.get('reason')}\")
except Exception as e:
    print(f'(could not parse describe-tasks JSON: {e})')
" || true

  EXIT_CODE=$(echo "${DESCRIBE_JSON}" | python3 -c "
import json, sys
try:
    t = (json.load(sys.stdin).get('tasks') or [{}])[0]
    for c in t.get('containers', []) or []:
        if c.get('name') == 'harness-runner':
            ec = c.get('exitCode')
            print('' if ec is None else ec); sys.exit(0)
    print('')
except Exception:
    print('')
" 2>/dev/null || echo "")
  STOP_REASON=$(echo "${DESCRIBE_JSON}" | python3 -c "
import json, sys
try:
    t = (json.load(sys.stdin).get('tasks') or [{}])[0]
    print(t.get('stoppedReason') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
  info "Task stopped: exitCode=${EXIT_CODE:-<none>} stoppedReason=${STOP_REASON}"

  # ── Best-effort log dump ────────────────────────────────────────────────
  # Derive the awslogs group + stream prefix directly from the task
  # definition's container logConfiguration so we never guess wrong.
  info "Resolving awslogs config from task definition ..."
  TASK_DEF_FULL_ARN=$(echo "${DESCRIBE_JSON}" | python3 -c "
import json, sys
try:
    t = (json.load(sys.stdin).get('tasks') or [{}])[0]
    print(t.get('taskDefinitionArn') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")

  if [[ -n "${TASK_DEF_FULL_ARN}" ]]; then
    TD_JSON=$(aws ecs describe-task-definition \
      --task-definition "${TASK_DEF_FULL_ARN}" \
      --region "${REGION}" \
      --output json 2>/dev/null || echo '{}')
    LOG_INFO=$(echo "${TD_JSON}" | python3 -c "
import json, sys
try:
    td = json.load(sys.stdin).get('taskDefinition') or {}
    for c in td.get('containerDefinitions', []) or []:
        if c.get('name') == 'harness-runner':
            lc = c.get('logConfiguration') or {}
            if lc.get('logDriver') == 'awslogs':
                opts = lc.get('options') or {}
                print(opts.get('awslogs-group',''))
                print(opts.get('awslogs-stream-prefix',''))
            break
except Exception:
    pass
" 2>/dev/null || echo "")
    LOG_GROUP=$(echo "${LOG_INFO}" | sed -n '1p')
    LOG_PREFIX=$(echo "${LOG_INFO}" | sed -n '2p')

    if [[ -n "${LOG_GROUP}" && -n "${LOG_PREFIX}" ]]; then
      LOG_STREAM="${LOG_PREFIX}/harness-runner/${TASK_ID}"
      info "=== CloudWatch logs (group=${LOG_GROUP} stream=${LOG_STREAM}) ==="
      aws logs get-log-events \
        --log-group-name "${LOG_GROUP}" \
        --log-stream-name "${LOG_STREAM}" \
        --region "${REGION}" \
        --limit "${LOG_EVENT_LIMIT:-200}" \
        --no-start-from-head \
        --output json 2>/dev/null \
        | python3 -c "
import json, sys
try:
    for e in json.load(sys.stdin).get('events', []) or []:
        print(e.get('message',''))
except Exception as e:
    print(f'(could not read log events: {e})')
" || warn "Log retrieval failed (non-fatal)."
    else
      warn "Could not resolve awslogs group/prefix from task definition (non-fatal)."
    fi
  else
    warn "No taskDefinitionArn on stopped task; skipping log dump."
  fi

  if [[ "${EXIT_CODE}" != "0" ]]; then
    error "Harness task exited non-zero (exitCode=${EXIT_CODE:-<none>})"
    exit 1
  fi
  success "Harness task completed cleanly"
fi
