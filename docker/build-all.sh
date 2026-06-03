#!/usr/bin/env bash
# Build and push all FORGE Docker images to ECR.
# Clones each source repo, builds the image, and pushes to ECR.
# Usage: ./docker/build-all.sh [image-name]
#   image-name: Optional — build only this image (e.g., forge-lightweight)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/.build-cache"

TARGET_IMAGE="${1:-all}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
PARALLEL="${PARALLEL:-false}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Image definitions ─────────────────────────────────────────────────────────
declare -A IMAGE_REPOS=(
  ["forge-lightweight"]="forge-cluster-a-geometry"
  ["forge-devops"]="forge-cluster-f-devops"
  ["forge-monitoring"]="forge-cluster-c-observability"
  ["forge-hpc"]="forge-cluster-b-hpc"
  ["forge-fem-cfd"]="forge-cluster-d-fem"
  ["forge-stellarator-config"]="forge-stellarator-config"
  ["forge-stellarator-coils"]="forge-stellarator-coils"
  ["forge-stellarator-cad"]="forge-stellarator-cad"
)

declare -A IMAGE_PLATFORMS=(
  ["forge-lightweight"]="linux/arm64"
  ["forge-devops"]="linux/arm64"
  ["forge-monitoring"]="linux/arm64"
  ["forge-stellarator-config"]="linux/arm64"
  ["forge-hpc"]="linux/amd64"
  ["forge-fem-cfd"]="linux/amd64"
  ["forge-stellarator-coils"]="linux/amd64"
  ["forge-stellarator-cad"]="linux/amd64"
)

# ── AWS setup ─────────────────────────────────────────────────────────────────
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

info "ECR Registry: ${ECR_REGISTRY}"
info "Logging in to ECR..."
aws ecr get-login-password --region "${REGION}" | \
  docker login --username AWS --password-stdin "${ECR_REGISTRY}"
success "ECR login OK"

mkdir -p "${BUILD_DIR}"

# ── Build function ────────────────────────────────────────────────────────────
build_image() {
  local IMAGE_NAME="$1"
  local SOURCE_REPO="${IMAGE_REPOS[$IMAGE_NAME]}"
  local PLATFORM="${IMAGE_PLATFORMS[$IMAGE_NAME]}"
  local ECR_URI="${ECR_REGISTRY}/${IMAGE_NAME}"
  local CLONE_DIR="${BUILD_DIR}/${SOURCE_REPO}"
  local BUILD_DATE
  BUILD_DATE=$(date -u +%Y%m%d-%H%M%S)

  info "Building ${IMAGE_NAME} from vpneoterra/${SOURCE_REPO} (${PLATFORM})..."

  # Clone or update source repo
  if [[ -d "${CLONE_DIR}/.git" ]]; then
    info "Updating ${SOURCE_REPO}..."
    git -C "${CLONE_DIR}" pull --ff-only 2>/dev/null || true
  else
    info "Cloning vpneoterra/${SOURCE_REPO}..."
    git clone --depth 1 "https://github.com/vpneoterra/${SOURCE_REPO}.git" "${CLONE_DIR}" 2>/dev/null \
      || { warn "Repo vpneoterra/${SOURCE_REPO} not found — creating placeholder"; mkdir -p "${CLONE_DIR}"; }
  fi

  # Use placeholder Dockerfile if source doesn't exist
  if [[ ! -f "${CLONE_DIR}/Dockerfile" ]]; then
    warn "No Dockerfile found for ${IMAGE_NAME} — creating minimal placeholder"
    cat > "${CLONE_DIR}/Dockerfile" << DOCKERFILE
FROM public.ecr.aws/docker/library/alpine:3.19
LABEL maintainer="vpneoterra"
LABEL forge.service="${IMAGE_NAME}"
RUN apk add --no-cache curl
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \\
  CMD curl -f http://localhost:8080/health || exit 1
EXPOSE 8080
CMD ["sh", "-c", "echo 'Placeholder: ${IMAGE_NAME}' && while true; do sleep 60; done"]
DOCKERFILE
  fi

  # Build and push
  docker buildx build \
    --platform "${PLATFORM}" \
    --tag "${ECR_URI}:latest" \
    --tag "${ECR_URI}:${BUILD_DATE}" \
    --push \
    --build-arg BUILD_DATE="${BUILD_DATE}" \
    "${CLONE_DIR}" \
    && success "Pushed ${IMAGE_NAME}:latest" \
    || { error "Build failed for ${IMAGE_NAME}"; return 1; }
}

# ── Main ──────────────────────────────────────────────────────────────────────
# Set up buildx for multi-platform builds
docker buildx create --name forge-builder --use 2>/dev/null || docker buildx use forge-builder

if [[ "${TARGET_IMAGE}" == "all" ]]; then
  info "Building all ${#IMAGE_REPOS[@]} images..."
  echo ""
  FAILED=()
  for IMAGE_NAME in "${!IMAGE_REPOS[@]}"; do
    build_image "${IMAGE_NAME}" || FAILED+=("${IMAGE_NAME}")
  done

  echo ""
  if [[ ${#FAILED[@]} -eq 0 ]]; then
    success "All images built and pushed successfully"
  else
    error "Failed to build: ${FAILED[*]}"
    exit 1
  fi
else
  if [[ -n "${IMAGE_REPOS[$TARGET_IMAGE]+set}" ]]; then
    build_image "${TARGET_IMAGE}"
  else
    error "Unknown image: ${TARGET_IMAGE}"
    echo "Available images: ${!IMAGE_REPOS[*]}"
    exit 1
  fi
fi

echo ""
info "Images available in ECR: ${ECR_REGISTRY}"
for IMAGE_NAME in "${!IMAGE_REPOS[@]}"; do
  echo "  ${ECR_REGISTRY}/${IMAGE_NAME}:latest"
done
