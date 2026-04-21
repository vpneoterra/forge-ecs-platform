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
# DOES NOT run the harness. See harness-run.sh for that.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_NAME="${1:-dev}"
EXTRA_TAG="${2:-}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
IMAGE_NAME="forge-testing-harness"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_URI="${ECR_REGISTRY}/${IMAGE_NAME}"
BUILD_DATE=$(date -u +%Y%m%d-%H%M%S)

info "Env: ${ENV_NAME}"
info "ECR URI: ${ECR_URI}"

info "Logging in to ECR ..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"
success "ECR login OK"

BUILD_ARGS=(buildx build --platform linux/amd64 --tag "${ECR_URI}:latest" --tag "${ECR_URI}:${BUILD_DATE}")
if [[ -n "${EXTRA_TAG}" ]]; then
  BUILD_ARGS+=(--tag "${ECR_URI}:${EXTRA_TAG}")
fi
BUILD_ARGS+=(--push "${REPO_ROOT}/docker/testing-harness")

info "Building ${IMAGE_NAME}:latest${EXTRA_TAG:+ (+:${EXTRA_TAG})} (linux/amd64) ..."
docker "${BUILD_ARGS[@]}"
success "Pushed ${ECR_URI}:latest (and :${BUILD_DATE}${EXTRA_TAG:+, :${EXTRA_TAG}})"
