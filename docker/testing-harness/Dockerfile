FROM public.ecr.aws/docker/library/python:3.12-slim

LABEL maintainer="vpneoterra"
LABEL forge.service="forge-testing-harness"
LABEL forge.tier="2"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY runner.py ./

# Shape corpus is cloned at run-time from vpneoterra/forgenew
# (server/axiom/chips/shapes/). Setting SHAPE_CORPUS_DIR lets operators
# mount or pre-bake a local corpus instead.
ENV SHAPE_CORPUS_DIR="/corpus/shapes" \
    FORGENEW_REPO="https://github.com/vpneoterra/forgenew.git" \
    FORGENEW_SUBPATH="server/axiom/chips/shapes" \
    OMNI_BASE_URL="" \
    OMNI_RENDER_PATH="/api/sdf/render" \
    OMNI_HEALTH_PATH="/api/health" \
    PER_PART_TIMEOUT_SEC="120" \
    DEFAULT_VOXEL_SIZE_MM="0.5" \
    EXPECTED_SHAPE_CHIP_COUNT="313" \
    MAX_PARTS_PER_RUN="313" \
    OUTPUT_DIR="/tmp/harness-output"

ENTRYPOINT ["python", "/app/runner.py"]
