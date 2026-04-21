FROM public.ecr.aws/docker/library/python:3.12-slim

LABEL maintainer="vpneoterra"
LABEL forge.service="forge-testing-harness"
LABEL forge.tier="2"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# git/curl kept for operator debugging; runtime no longer shells out to
# git clone by default (corpus is baked into the image below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY runner.py ./

# Shape-chip corpus is staged into the build context by the CI workflow
# (or `scripts/harness-build.sh` when invoked locally with FORGENEW_DIR
# pointing at a checkout). The fallback empty marker keeps the COPY step
# from failing when the corpus is deliberately omitted (e.g. image-only
# rebuilds); the runner fails closed in that case.
COPY corpus/ /corpus/

ENV SHAPE_CORPUS_DIR="/corpus/shapes" \
    FORGENEW_REPO="https://github.com/vpneoterra/forgenew.git" \
    FORGENEW_SUBPATH="server/axiom/chips/shapes" \
    ALLOW_RUNTIME_CLONE="false" \
    OMNI_BASE_URL="" \
    OMNI_RENDER_PATH="/api/sdf/render" \
    OMNI_HEALTH_PATH="/api/health" \
    PER_PART_TIMEOUT_SEC="120" \
    DEFAULT_VOXEL_SIZE_MM="0.5" \
    VOXEL_BUDGET_RETRY="true" \
    VOXEL_SIZE_SAFETY_MULT="1.60" \
    MAX_VOXEL_SIZE_MM="5.0" \
    EXPECTED_SHAPE_CHIP_COUNT="313" \
    MAX_PARTS_PER_RUN="313" \
    OUTPUT_DIR="/tmp/harness-output"

ENTRYPOINT ["python", "/app/runner.py"]
