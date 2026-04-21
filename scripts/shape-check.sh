#!/usr/bin/env bash
# Shape Check
# ===========
#
# Reusable corpus evaluation process for FORGE shape chips.
#
# Unlike run-tier2-313-shapes.yml, this script intentionally runs one ECS
# harness task per shape. That makes the result set fair: one renderer crash
# cannot poison all subsequent shapes with cascading 502s. It also scales to
# future 1000+ shape corpora through dynamic corpus counting plus start/limit
# windowing.
#
# Usage:
#   START_INDEX=0 LIMIT=313 ./scripts/shape-check.sh dev
#
# Required by CI:
#   - FORGENEW_DIR checkout with server/axiom/chips/shapes
#   - ForgeTestingHarness-<env> already deployed
#   - harness image already built/pushed with the same corpus
set -uo pipefail

ENV_NAME="${1:-dev}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
START_INDEX="${START_INDEX:-0}"
LIMIT="${LIMIT:-all}"
FORGENEW_SUBPATH="${FORGENEW_SUBPATH:-server/axiom/chips/shapes}"
CORPUS_DIR="${CORPUS_DIR:-${FORGENEW_DIR:-}/$FORGENEW_SUBPATH}"
OUT_DIR="${SHAPE_CHECK_OUT_DIR:-shape-check-artifacts}"
LOG_DIR="${OUT_DIR}/per-shape-logs"
DIAG_DIR="${OUT_DIR}/diagnostics"
OMNI_BASE_URL="${OMNI_BASE_URL:-https://omni.qrucible.ai}"
OMNI_HEALTH_PATH="${OMNI_HEALTH_PATH:-/api/health}"
OMNI_HEALTH_WAIT_SEC="${OMNI_HEALTH_WAIT_SEC:-360}"
MAX_RENDERER_BLOCKERS="${MAX_RENDERER_BLOCKERS:-0}"
LOG_EVENT_LIMIT="${LOG_EVENT_LIMIT:-1200}"
DEFAULT_VOXEL_SIZE_MM="${DEFAULT_VOXEL_SIZE_MM:-0.5}"
PER_PART_TIMEOUT_SEC="${PER_PART_TIMEOUT_SEC:-150}"
VOXEL_BUDGET_RETRY="${VOXEL_BUDGET_RETRY:-true}"
VOXEL_SIZE_SAFETY_MULT="${VOXEL_SIZE_SAFETY_MULT:-2.25}"
MAX_VOXEL_SIZE_MM="${MAX_VOXEL_SIZE_MM:-5.0}"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[SHAPE-CHECK]${NC} $*"; }
success() { echo -e "${GREEN}[SHAPE-CHECK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[SHAPE-CHECK]${NC} $*"; }
error()   { echo -e "${RED}[SHAPE-CHECK]${NC} $*" >&2; }

mkdir -p "${OUT_DIR}" "${LOG_DIR}" "${DIAG_DIR}"
: > "${OUT_DIR}/shape-check-results.jsonl"

if [[ -z "${FORGENEW_DIR:-}" && -z "${CORPUS_DIR:-}" ]]; then
  error "FORGENEW_DIR or CORPUS_DIR must be set."
  exit 2
fi
if [[ ! -d "${CORPUS_DIR}" ]]; then
  error "Shape corpus directory not found: ${CORPUS_DIR}"
  exit 2
fi
if ! [[ "${START_INDEX}" =~ ^[0-9]+$ ]]; then
  error "START_INDEX must be a non-negative integer, got ${START_INDEX}"
  exit 2
fi
if [[ "${MAX_RENDERER_BLOCKERS}" != "0" ]] && ! [[ "${MAX_RENDERER_BLOCKERS}" =~ ^[0-9]+$ ]]; then
  error "MAX_RENDERER_BLOCKERS must be 0 or a positive integer, got ${MAX_RENDERER_BLOCKERS}"
  exit 2
fi

python3 - <<'PY' "${CORPUS_DIR}" "${OUT_DIR}/shape-manifest.jsonl"
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
rows = []
for idx, path in enumerate(sorted(root.rglob("*.json"))):
    try:
        chip = json.loads(path.read_text())
    except Exception as exc:
        chip = {"chip_id": None, "payload": {"name": None}, "_load_error": str(exc)}
    payload = chip.get("payload") or {}
    rows.append({
        "shape_index": idx,
        "source_path": str(path.relative_to(root)),
        "chip_id": chip.get("chip_id"),
        "name": payload.get("name") or chip.get("chip_id") or path.stem,
        "industry": ((payload.get("industry_classification") or {}).get("hierarchy") or {}).get("industry"),
        "sub_industry": ((payload.get("industry_classification") or {}).get("hierarchy") or {}).get("sub_industry"),
    })
out.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
print(len(rows))
PY
CORPUS_COUNT=$(wc -l < "${OUT_DIR}/shape-manifest.jsonl" | tr -d ' ')
EXPECTED_SHAPE_CHIP_COUNT="${EXPECTED_SHAPE_CHIP_COUNT:-${CORPUS_COUNT}}"
if [[ "${EXPECTED_SHAPE_CHIP_COUNT}" != "${CORPUS_COUNT}" ]]; then
  error "EXPECTED_SHAPE_CHIP_COUNT=${EXPECTED_SHAPE_CHIP_COUNT} does not match discovered corpus count ${CORPUS_COUNT}."
  exit 2
fi
if [[ "${LIMIT}" == "all" || -z "${LIMIT}" ]]; then
  LIMIT=$(( CORPUS_COUNT - START_INDEX ))
elif ! [[ "${LIMIT}" =~ ^[0-9]+$ ]]; then
  error "LIMIT must be a positive integer or 'all', got ${LIMIT}"
  exit 2
fi
if [[ "${LIMIT}" -lt 1 ]]; then
  error "LIMIT must be >= 1 after normalization, got ${LIMIT}"
  exit 2
fi
END_EXCLUSIVE=$(( START_INDEX + LIMIT ))
if [[ "${START_INDEX}" -ge "${CORPUS_COUNT}" || "${END_EXCLUSIVE}" -gt "${CORPUS_COUNT}" ]]; then
  error "Requested window start=${START_INDEX} limit=${LIMIT} exceeds corpus_count=${CORPUS_COUNT}"
  exit 2
fi

cat > "${OUT_DIR}/shape-check-run-metadata.json" <<JSON
{
  "environment": "${ENV_NAME}",
  "region": "${REGION}",
  "corpus_count": ${CORPUS_COUNT},
  "start_index": ${START_INDEX},
  "limit": ${LIMIT},
  "end_exclusive": ${END_EXCLUSIVE},
  "default_voxel_size_mm": ${DEFAULT_VOXEL_SIZE_MM},
  "per_part_timeout_sec": ${PER_PART_TIMEOUT_SEC},
  "voxel_budget_retry": "${VOXEL_BUDGET_RETRY}",
  "voxel_size_safety_mult": ${VOXEL_SIZE_SAFETY_MULT},
  "max_voxel_size_mm": ${MAX_VOXEL_SIZE_MM},
  "max_renderer_blockers": ${MAX_RENDERER_BLOCKERS},
  "omni_base_url": "${OMNI_BASE_URL}"
}
JSON

wait_omni_health() {
  local deadline=$(( $(date +%s) + OMNI_HEALTH_WAIT_SEC ))
  local url="${OMNI_BASE_URL}${OMNI_HEALTH_PATH}"
  while [[ "$(date +%s)" -lt "${deadline}" ]]; do
    if python3 - <<'PY' "${url}" >/dev/null 2>&1; then
import sys
import urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=10) as r:
    if r.status != 200:
        raise SystemExit(1)
PY
      return 0
    fi
    sleep 10
  done
  return 1
}

capture_omni_snapshot() {
  local idx="$1"
  local prefix="${DIAG_DIR}/shape-${idx}"
  local cluster="forge-app-${ENV_NAME}"
  local service="forge-omni"
  aws ecs describe-services --cluster "${cluster}" --services "${service}" --region "${REGION}" --output json > "${prefix}-service.json" 2>&1 || true
  aws ecs list-tasks --cluster "${cluster}" --service-name "${service}" --desired-status STOPPED --region "${REGION}" --query 'taskArns[0:5]' --output text > "${prefix}-stopped-task-arns.txt" 2>&1 || true
  local stopped
  stopped=$(cat "${prefix}-stopped-task-arns.txt")
  if [[ -n "${stopped}" && "${stopped}" != "None" ]]; then
    aws ecs describe-tasks --cluster "${cluster}" --tasks ${stopped} --region "${REGION}" --output json > "${prefix}-stopped-tasks.json" 2>&1 || true
  fi
}

append_result() {
  python3 - <<'PY' "$@"
import json
import pathlib
import re
import sys

log_path = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
out_path = pathlib.Path(sys.argv[3])
shape_index = int(sys.argv[4])
harness_exit_code = int(sys.argv[5])
health_after = sys.argv[6]

manifest = {}
for line in manifest_path.read_text().splitlines():
    row = json.loads(line)
    manifest[row["shape_index"]] = row
meta = manifest.get(shape_index, {"shape_index": shape_index, "name": f"shape-{shape_index}"})

result = None
raw = log_path.read_text(errors="replace") if log_path.exists() else ""
for line in raw.splitlines():
    marker = "HARNESS_RESULT_JSON "
    if marker in line:
        try:
            result = json.loads(line.split(marker, 1)[1])
        except Exception as exc:
            result = {"ok": False, "failure_type": "artifact_parse_error", "error": str(exc)}

if result is None:
    result = {
        "ok": False,
        "failure_type": "no_structured_result",
        "error": f"harness exited {harness_exit_code} without HARNESS_RESULT_JSON",
    }

result.setdefault("shape_index", shape_index)
result.setdefault("name", meta.get("name"))
result.setdefault("chip_id", meta.get("chip_id"))
result.setdefault("source_path", meta.get("source_path"))
result["harness_exit_code"] = harness_exit_code
result["omni_health_after"] = health_after
result["shape_check_isolated"] = True

err = str(result.get("error") or "")
ft = result.get("failure_type")
if not ft and not result.get("ok"):
    low = err.lower()
    if "voxel_budget" in low:
        ft = "voxel_budget_exceeded"
    elif "render_budget" in low:
        ft = "render_budget_exceeded"
    elif err.startswith("http 5"):
        ft = "http_5xx"
    elif err.startswith("http 4"):
        ft = "http_4xx"
    elif "timeout" in low:
        ft = "transport_timeout"
    else:
        ft = "render_error" if err else "unknown"
    result["failure_type"] = ft

if result.get("ok"):
    classification = "good_renderable"
    recommendation = "keep"
elif ft == "voxel_budget_exceeded":
    classification = "good_needs_coarse_or_scale_tier"
    recommendation = "keep_for_coarse_preview_or_stress_tier"
elif ft == "render_budget_exceeded" or "render_budget_exceeded" in err.lower():
    classification = "good_complexity_limited"
    recommendation = "keep_but_quarantine_from_default_render"
elif ft in ("http_5xx", "transport_timeout", "no_structured_result"):
    classification = "renderer_blocker"
    recommendation = "quarantine_and_add_renderer_guard"
elif ft in ("http_4xx", "non_json_response"):
    classification = "chip_or_api_contract_error"
    recommendation = "inspect_chip_payload_or_api_mapping"
elif ft in ("render_error", "unknown"):
    classification = "chip_or_renderer_error"
    recommendation = "inspect_shape_and_router_mapping"
else:
    classification = "needs_triage"
    recommendation = "inspect"

suggested = None
m = re.search(r"voxelSize\s*>=\s*([0-9]+(?:\.[0-9]+)?)", err, re.I)
if m:
    try:
        suggested = float(m.group(1))
    except ValueError:
        suggested = None
result["shape_check_classification"] = classification
result["shape_check_recommendation"] = recommendation
result["suggested_min_voxel_size_mm"] = suggested

with out_path.open("a") as f:
    f.write(json.dumps(result, sort_keys=True) + "\n")
print(json.dumps(result, sort_keys=True))
PY
}

renderer_blockers=0
info "Shape Check starting: env=${ENV_NAME} corpus=${CORPUS_COUNT} window=${START_INDEX}..$((END_EXCLUSIVE - 1))"

for ((idx = START_INDEX; idx < END_EXCLUSIVE; idx++)); do
  printf -v padded "%04d" "${idx}"
  log_file="${LOG_DIR}/shape-${padded}.log"
  info "shape_index=${idx} isolated ECS task"

  set +e
  RUN_LIMIT=1 \
  EXPECTED_SHAPE_CHIP_COUNT="${EXPECTED_SHAPE_CHIP_COUNT}" \
  SHAPE_START_INDEX="${idx}" \
  STOP_ON_FAILURE=false \
  WAIT_FOR_COMPLETION=true \
  LOG_EVENT_LIMIT="${LOG_EVENT_LIMIT}" \
  DEFAULT_VOXEL_SIZE_MM="${DEFAULT_VOXEL_SIZE_MM}" \
  PER_PART_TIMEOUT_SEC="${PER_PART_TIMEOUT_SEC}" \
  VOXEL_BUDGET_RETRY="${VOXEL_BUDGET_RETRY}" \
  VOXEL_SIZE_SAFETY_MULT="${VOXEL_SIZE_SAFETY_MULT}" \
  MAX_VOXEL_SIZE_MM="${MAX_VOXEL_SIZE_MM}" \
  ./scripts/harness-run.sh "${ENV_NAME}" > "${log_file}" 2>&1
  rc=$?
  set -u

  health_after="not_checked"
  if wait_omni_health; then
    health_after="healthy"
  else
    health_after="unhealthy_after_wait"
    warn "OMNI did not become healthy within ${OMNI_HEALTH_WAIT_SEC}s after shape ${idx}"
  fi

  record=$(append_result "${log_file}" "${OUT_DIR}/shape-manifest.jsonl" "${OUT_DIR}/shape-check-results.jsonl" "${idx}" "${rc}" "${health_after}")
  echo "${record}" | tee "${OUT_DIR}/last-result.json" >/dev/null

  if echo "${record}" | grep -q '"shape_check_classification": "renderer_blocker"'; then
    renderer_blockers=$((renderer_blockers + 1))
    capture_omni_snapshot "${idx}"
    if [[ "${MAX_RENDERER_BLOCKERS}" != "0" && "${renderer_blockers}" -ge "${MAX_RENDERER_BLOCKERS}" ]]; then
      warn "MAX_RENDERER_BLOCKERS=${MAX_RENDERER_BLOCKERS} reached; stopping early to protect cost/time."
      break
    fi
  fi
done

python3 - <<'PY' "${OUT_DIR}"
import collections
import csv
import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1])
results = [json.loads(line) for line in (out / "shape-check-results.jsonl").read_text().splitlines() if line.strip()]
manifest = [json.loads(line) for line in (out / "shape-manifest.jsonl").read_text().splitlines() if line.strip()]
by_class = collections.Counter(r.get("shape_check_classification", "unknown") for r in results)
by_failure = collections.Counter((r.get("failure_type") or "ok") for r in results)
summary = {
    "corpus_count": len(manifest),
    "evaluated": len(results),
    "ok": sum(1 for r in results if r.get("ok")),
    "failed": sum(1 for r in results if not r.get("ok")),
    "classification_counts": dict(sorted(by_class.items())),
    "failure_type_counts": dict(sorted(by_failure.items())),
    "first_renderer_blocker": next(({
        "shape_index": r.get("shape_index"),
        "name": r.get("name"),
        "failure_type": r.get("failure_type"),
        "error": r.get("error"),
    } for r in results if r.get("shape_check_classification") == "renderer_blocker"), None),
}
(out / "shape-check-summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")

with (out / "shape-check-classification.csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "shape_index", "name", "chip_id", "source_path", "ok", "failure_type",
        "classification", "recommendation", "suggested_min_voxel_size_mm",
        "voxel_size_mm", "elapsed_ms", "omni_health_after", "error",
    ])
    writer.writeheader()
    for r in results:
        writer.writerow({
            "shape_index": r.get("shape_index"),
            "name": r.get("name"),
            "chip_id": r.get("chip_id"),
            "source_path": r.get("source_path"),
            "ok": r.get("ok"),
            "failure_type": r.get("failure_type"),
            "classification": r.get("shape_check_classification"),
            "recommendation": r.get("shape_check_recommendation"),
            "suggested_min_voxel_size_mm": r.get("suggested_min_voxel_size_mm"),
            "voxel_size_mm": r.get("voxel_size_mm"),
            "elapsed_ms": r.get("elapsed_ms"),
            "omni_health_after": r.get("omni_health_after"),
            "error": str(r.get("error") or "")[:1000],
        })

lines = [
    "# Shape Check Report",
    "",
    f"- Corpus count: {summary['corpus_count']}",
    f"- Evaluated: {summary['evaluated']}",
    f"- Good renderable: {by_class.get('good_renderable', 0)}",
    f"- Needs coarse/scale tier: {by_class.get('good_needs_coarse_or_scale_tier', 0)}",
    f"- Complexity limited: {by_class.get('good_complexity_limited', 0)}",
    f"- Renderer blockers: {by_class.get('renderer_blocker', 0)}",
    f"- Chip/API errors: {by_class.get('chip_or_api_contract_error', 0)}",
    f"- Other chip/renderer errors: {by_class.get('chip_or_renderer_error', 0)}",
    "",
    "## Classification counts",
    "",
]
for key, value in sorted(by_class.items()):
    lines.append(f"- {key}: {value}")
lines += ["", "## Failure type counts", ""]
for key, value in sorted(by_failure.items()):
    lines.append(f"- {key}: {value}")
if summary["first_renderer_blocker"]:
    frb = summary["first_renderer_blocker"]
    lines += [
        "",
        "## First renderer blocker",
        "",
        f"- Shape index: {frb.get('shape_index')}",
        f"- Name: {frb.get('name')}",
        f"- Failure type: {frb.get('failure_type')}",
        f"- Error: {str(frb.get('error') or '')[:500]}",
    ]
lines += [
    "",
    "## Files",
    "",
    "- shape-check-results.jsonl: raw isolated per-shape records",
    "- shape-check-classification.csv: spreadsheet-friendly keep/fix/quarantine decisions",
    "- per-shape-logs/: one harness log per shape",
    "- diagnostics/: ECS service/stopped-task snapshots for renderer blockers",
]
(out / "shape-check-report.md").write_text("\n".join(lines) + "\n")
print(json.dumps(summary, indent=2, sort_keys=True))
PY

success "Shape Check complete. Artifacts in ${OUT_DIR}"
exit 0
