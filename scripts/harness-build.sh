#!/usr/bin/env bash
# Build and push the tier-2 testing-harness runner image to its ECR repo.
# Requires: deployTestingHarness=true stack already deployed (so the ECR
# repo `forge-testing-harness` exists).
#
# Usage:   ./scripts/harness-build.sh [env] [extra_tag]
#   env:        'dev' (default) | 'prod'
#   extra_tag:  optional additional tag (e.g. git SHA) pushed alongside
#               :latest and the UTC build-date tag.
#
# Environment:
#   FORGENEW_DIR   Required. Path to a local checkout of vpneoterra/forgenew
#                  whose `server/axiom/chips/shapes/` subtree contains the
#                  313 shape-chip JSONs. In CI the deploy-testing-harness
#                  workflow checks out forgenew via actions/checkout+GH_PAT
#                  and exports FORGENEW_DIR=$GITHUB_WORKSPACE/forgenew-src.
#                  If unset, the build will FAIL rather than ship an image
#                  that would try to `git clone` a private repo at runtime.
#   FORGENEW_SUBPATH  Optional. Defaults to server/axiom/chips/shapes.
#
# DOES NOT run the harness. See harness-run.sh for that.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_NAME="${1:-dev}"
EXTRA_TAG="${2:-}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
IMAGE_NAME="forge-testing-harness"
FORGENEW_SUBPATH="${FORGENEW_SUBPATH:-server/axiom/chips/shapes}"
HARNESS_CTX="${REPO_ROOT}/docker/testing-harness"
CORPUS_DST="${HARNESS_CTX}/corpus/shapes"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_URI="${ECR_REGISTRY}/${IMAGE_NAME}"
BUILD_DATE=$(date -u +%Y%m%d-%H%M%S)

info "Env: ${ENV_NAME}"
info "ECR URI: ${ECR_URI}"

# ── Stage shape-chip corpus into build context ────────────────────────────
if [[ -z "${FORGENEW_DIR:-}" ]]; then
  error "FORGENEW_DIR is not set. Point it at a local vpneoterra/forgenew"
  error "checkout (CI does this via actions/checkout + secrets.GH_PAT)."
  error "Refusing to build an image without a baked-in shape-chip corpus."
  exit 1
fi

SRC="${FORGENEW_DIR}/${FORGENEW_SUBPATH}"
if [[ ! -d "${SRC}" ]]; then
  error "Corpus subpath not found: ${SRC}"
  error "Expected ${FORGENEW_SUBPATH} under FORGENEW_DIR=${FORGENEW_DIR}"
  exit 1
fi

CHIP_COUNT=$(find "${SRC}" -type f -name '*.json' | wc -l | tr -d ' ')
info "Shape-chip corpus source: ${SRC} (json_count=${CHIP_COUNT})"
if [[ "${CHIP_COUNT}" -eq 0 ]]; then
  error "Corpus directory is empty (found 0 *.json files). Aborting."
  exit 1
fi
if [[ "${CHIP_COUNT}" -ne 313 ]]; then
  warn "Expected 313 shape chips, found ${CHIP_COUNT}. Image will still be"
  warn "built, but a full (non-SMOKE) run will trip the count guardrail."
fi

info "Staging corpus into build context: ${CORPUS_DST}"
rm -rf "${CORPUS_DST}"
mkdir -p "${CORPUS_DST}"
# -a preserves structure; trailing /. ensures contents (not parent) copied.
cp -a "${SRC}/." "${CORPUS_DST}/"
success "Corpus staged ($(find "${CORPUS_DST}" -type f -name '*.json' | wc -l | tr -d ' ') files)"

info "Logging in to ECR ..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
success "ECR login OK"

BUILD_ARGS=(buildx build --platform linux/amd64 --tag "${ECR_URI}:latest" --tag "${ECR_URI}:${BUILD_DATE}")
if [[ -n "${EXTRA_TAG}" ]]; then
  BUILD_ARGS+=(--tag "${ECR_URI}:${EXTRA_TAG}")
fi
BUILD_ARGS+=(--push "${HARNESS_CTX}")

info "Building ${IMAGE_NAME}:latest${EXTRA_TAG:+ (+:${EXTRA_TAG})} (linux/amd64) ..."
docker "${BUILD_ARGS[@]}"
success "Pushed ${ECR_URI}:latest (and :${BUILD_DATE}${EXTRA_TAG:+, :${EXTRA_TAG}})"
