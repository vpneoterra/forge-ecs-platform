# ============================================================
# forge-cluster-f-devops -- consolidated always-on DevOps task
# (Cluster F: Nginx + Forgejo + MinIO ; Cluster E: SysML v2 API)
#
# Single image, ARM64 (Graviton / Provider A), supervisord PID 1.
# Processes & ports (see README.md for the authoritative table):
#   nginx        :80    -> /healthz, /git/ -> Forgejo, /sysml/ + :9000 SysML
#   sysml-java   :8003  (internal) official SysML v2 API Services JAR
#   sysml-api    :9000  FastAPI sidecar (SYSML_API_PORT) proxying :8003
#   forgejo      :3000  (internal) HTTP, data root /forge/repos
#   minio        :9090  S3 API (internal), :9091 console, data /forge/minio
#
# EFS durability: /forge/repos (Forgejo) and /forge/minio (MinIO object store)
# are EFS access-point mounts supplied by the ECS task definition.
# ============================================================
FROM --platform=linux/arm64 eclipse-temurin:17-jre-jammy

LABEL maintainer="vpneoterra" \
      forge.service="forge-devops" \
      forge.cluster="F+E" \
      description="Nginx + Forgejo + MinIO + SysML v2 API (consolidated, arm64)"

ARG BUILD_DATE=unknown
ARG GIT_SHA=unknown
LABEL forge.build_date="${BUILD_DATE}" forge.git_sha="${GIT_SHA}"

# Pinned upstream versions (arm64 binaries all exist for these).
ENV FORGEJO_VERSION=9.0.3 \
    MINIO_RELEASE=RELEASE.2024-10-13T13-34-11Z \
    GRADLE_VERSION=8.5

# ── Base OS packages ─────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3-pip \
      nginx \
      curl wget git ca-certificates gettext-base \
      supervisor unzip git-lfs openssh-client \
    && rm -rf /var/lib/apt/lists/*

# ── Forgejo binary (arm64) ───────────────────────────────────
# Codeberg publishes per-arch static binaries; the container image
# codeberg.org/forgejo/forgejo:14 wraps the same binary. We embed the
# binary directly so this stays a single supervised process.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) fj_arch="arm64" ;; \
      amd64) fj_arch="amd64" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    wget -q --timeout=120 \
      "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO_VERSION}/forgejo-${FORGEJO_VERSION}-linux-${fj_arch}" \
      -O /usr/local/bin/forgejo; \
    chmod +x /usr/local/bin/forgejo; \
    /usr/local/bin/forgejo --version
# Dedicated git user for Forgejo (data lives on EFS at /forge/repos).
RUN useradd --system --create-home --home-dir /var/lib/forgejo --shell /bin/bash git

# ── MinIO server + client (arm64) ────────────────────────────
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    wget -q --timeout=120 \
      "https://dl.min.io/server/minio/release/linux-${arch}/archive/minio.${MINIO_RELEASE}" \
      -O /usr/local/bin/minio; \
    chmod +x /usr/local/bin/minio; \
    wget -q --timeout=120 \
      "https://dl.min.io/client/mc/release/linux-${arch}/mc" \
      -O /usr/local/bin/mc; \
    chmod +x /usr/local/bin/mc

# ── SysML v2 API Services JAR (port to 8003 internal) ────────
# Ported from forgenew/docker/sysml/Dockerfile: try the published JAR,
# fall back to a Gradle shadowJar build. Java bytecode is arch-independent
# so the JAR runs natively on Graviton. See README "SysML JAR" caveat.
RUN mkdir -p /opt/sysml
WORKDIR /opt/sysml
RUN wget -q --timeout=60 \
      "https://github.com/Systems-Modeling/SysML-v2-API-Services/releases/latest/download/sysml-v2-api-services.jar" \
      -O sysml-v2-api-services.jar \
    || echo "WARNING: prebuilt SysML JAR not available; will attempt Gradle build"
RUN if [ ! -s sysml-v2-api-services.jar ]; then \
      wget -q https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -O /tmp/gradle.zip && \
      unzip -q /tmp/gradle.zip -d /opt && \
      ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle && \
      git clone --depth=1 https://github.com/Systems-Modeling/SysML-v2-API-Services.git /opt/sysml/src && \
      cd /opt/sysml/src && gradle --no-daemon shadowJar && \
      cp build/libs/*-all.jar /opt/sysml/sysml-v2-api-services.jar 2>/dev/null || cp build/libs/*.jar /opt/sysml/sysml-v2-api-services.jar && \
      cd /opt/sysml && rm -rf src /opt/gradle-${GRADLE_VERSION} /tmp/gradle.zip; \
    fi

# ── Python sidecar venv (FastAPI health/metrics + proxy) ─────
RUN python3.11 -m venv /opt/sidecar-venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/sidecar-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# ── Config + entrypoints ─────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/forge-devops.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY api_wrapper.py /app/api_wrapper.py
COPY entrypoint.sh /usr/local/bin/forge-entrypoint.sh
COPY forgejo-app.ini.tmpl /etc/forgejo/app.ini.tmpl
RUN chmod +x /usr/local/bin/forge-entrypoint.sh && \
    mkdir -p /app/logs /etc/forgejo /var/log/supervisor \
             /forge/repos /forge/minio /run/forgejo && \
    chown -R git:git /etc/forgejo /run/forgejo

EXPOSE 80 9000

# Runtime configuration (overridable by the ECS task definition).
ENV SYSML_JAVA_PORT=8003 \
    SYSML_API_PORT=9000 \
    FORGEJO_HTTP_PORT=3000 \
    FORGEJO_DOMAIN=git.forge.local \
    FORGEJO_ROOT_URL=http://git.forge.local/ \
    MINIO_API_PORT=9090 \
    MINIO_CONSOLE_PORT=9091 \
    MINIO_ROOT_USER=forge-admin \
    MINIO_ROOT_PASSWORD=change-me-at-runtime \
    FORGE_TIMEOUT=300 \
    JAVA_OPTS="-Xmx1024m -XX:+UseContainerSupport" \
    PYTHONUNBUFFERED=1

# Nginx /healthz is the task-level health surface (port 80).
HEALTHCHECK --interval=30s --timeout=15s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:80/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/forge-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/forge-devops.conf"]
