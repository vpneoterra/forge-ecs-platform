#!/usr/bin/env bash
# metaforge-build.sh -- build the Omnigent server image (vpneoterra fork) and
# push it to ECR for the ForgeMetaForgeStack to pull.
#
# WHY build-from-source: the fork publishes NO GHCR package of its own, and the
# web UI SPA bundle is gitignored. A plain pip/source build ships WITHOUT a UI.
# The multi-stage Dockerfile runs its web-builder stage to compile ap-web, so
# building `--target server` via the Dockerfile produces a COMPLETE image. We
# verify the SPA assets exist before pushing.
#
# Usage:
#   AWS_REGION=us-east-1 ACCOUNT_ID=123456789012 ./metaforge-build.sh
# Optional:
#   FORK_URL   (default https://github.com/vpneoterra/omnigent.git)
#   FORK_REF   (default main)
#   ECR_REPO   (default metaforge)
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:?set ACCOUNT_ID to your AWS account id}"
FORK_URL="${FORK_URL:-https://github.com/vpneoterra/omnigent.git}"
FORK_REF="${FORK_REF:-main}"
ECR_REPO="${ECR_REPO:-metaforge}"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
WORKDIR="$(mktemp -d)"

echo "==> Cloning ${FORK_URL}@${FORK_REF}"
git clone --depth 1 --branch "${FORK_REF}" "${FORK_URL}" "${WORKDIR}/omnigent"
cd "${WORKDIR}/omnigent"
GIT_SHA="$(git rev-parse --short HEAD)"
echo "    git sha: ${GIT_SHA}"

echo "==> Ensuring ECR repo '${ECR_REPO}' exists"
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${AWS_REGION}" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "${ECR_REPO}" --region "${AWS_REGION}" \
       --image-scanning-configuration scanOnPush=true >/dev/null

echo "==> Logging in to ECR"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

# Build the SERVER image via the multi-stage Dockerfile (runs web-builder).
# Do NOT build/push the `host` target here -- it belongs to the execution
# plane and (because it needs bubblewrap) cannot run on Fargate.
#
# NOTE: in the vpneoterra fork the server image is the Dockerfile's DEFAULT
# (final) target -- its named stage is `runtime`, there is no stage literally
# named `server`. `--target host` selects the host image; omitting --target (or
# `--target runtime`) selects the server. We build the default target and pass
# SERVER_TARGET (default empty -> default target) so this stays correct if the
# fork later renames the stage.
SERVER_TARGET="${SERVER_TARGET:-}"
IMAGE_LOCAL="omnigent-server:${GIT_SHA}"
echo "==> Building server image (multi-stage, includes web UI bundle)"
if [ -n "${SERVER_TARGET}" ]; then
  docker build -f deploy/docker/Dockerfile --target "${SERVER_TARGET}" -t "${IMAGE_LOCAL}" .
else
  docker build -f deploy/docker/Dockerfile -t "${IMAGE_LOCAL}" .
fi

# -- GATE: verify the compiled SPA bundle is present in the image ------------
# A source build without the web-builder stage would pass docker build but ship
# an empty UI. We assert the static assets exist before pushing. Adjust the
# probe path if the fork relocates the bundle.
# The fork's web-builder emits to omnigent/server/static/web-ui and the runtime
# stage preserves the tree under /build (the editable-install .pth files point at
# /build/omnigent by absolute path; WORKDIR is /app). The canonical asset is
# therefore /build/omnigent/server/static/web-ui/index.html. We probe that first
# and keep older/likely fallbacks so the gate survives a relocation.
echo "==> Verifying web UI bundle is present in the image"
if ! docker run --rm --entrypoint sh "${IMAGE_LOCAL}" -c \
     'ls -1 /build/omnigent/server/static/web-ui/index.html /app/omnigent/server/static/web-ui/index.html /app/omnigent/server/static/index.html /app/ap-web/dist/index.html 2>/dev/null | head -1' \
     | grep -q index.html; then
  echo "ERROR: web UI bundle not found in the image. Refusing to push a UI-less server." >&2
  echo "       Confirm the Dockerfile's web-builder stage ran (target=server), or" >&2
  echo "       fall back to mirroring ghcr.io/omnigent-ai/omnigent-server:latest into ECR." >&2
  exit 1
fi

REMOTE="${REGISTRY}/${ECR_REPO}:${GIT_SHA}"
echo "==> Tagging and pushing ${REMOTE}"
docker tag "${IMAGE_LOCAL}" "${REMOTE}"
docker push "${REMOTE}"
docker tag "${IMAGE_LOCAL}" "${REGISTRY}/${ECR_REPO}:latest"
docker push "${REGISTRY}/${ECR_REPO}:latest"

DIGEST="$(aws ecr describe-images --repository-name "${ECR_REPO}" --image-ids imageTag="${GIT_SHA}" \
  --region "${AWS_REGION}" --query 'imageDetails[0].imageDigest' --output text)"
echo ""
echo "==> Pushed. Pin the deploy to this immutable digest:"
echo "    npx cdk deploy ForgeMetaForge-dev -c deployMetaForge=true \\"
echo "      -c metaForgeImageDigest=${DIGEST}"
echo ""
echo "DIGEST=${DIGEST}"
