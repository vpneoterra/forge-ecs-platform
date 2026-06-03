# ============================================================
# forge-cluster-f-devops -- consolidated always-on DevOps task
# (Cluster F: Nginx + Forgejo + MinIO ; Cluster E: SysML v2 API)
#
# Single image, ARM64 (Graviton / Provider A), supervisord PID 1.
# Processes & ports (see README.md for the authoritative table):
#   nginx        :80    -> /healthz, /git/ -> Forgejo, /sysml/ + :9000 SysML
#   sysml-java   :8003  (internal) official SysML v2 API Services (Play dist)
#   sysml-api    :9000  FastAPI sidecar (SYSML_API_PORT) proxying :8003
#   sysml-db     :5432  (internal) local Postgres backing the SysML kernel
#   forgejo      :3000  (internal) HTTP, data root /forge/repos
#   minio        :9090  S3 API (internal), :9091 console, data /forge/minio
#
# EFS durability: /forge/repos (Forgejo) and /forge/minio (MinIO object store)
# are EFS access-point mounts supplied by the ECS task definition.
# ============================================================

# ── Stage 1: build the SysML v2 API Services (Play/sbt) ──────
# Upstream Systems-Modeling/SysML-v2-API-Services is a Play Framework app
# built with sbt (NOT Gradle, and no release JAR is published). We build the
# Play dist with `sbt stage`, producing a self-contained launcher under
# target/universal/stage/. Java bytecode is arch-independent, so we build on
# JDK17 and run on the arm64 temurin JRE runtime stage.
FROM --platform=linux/arm64 eclipse-temurin:17-jdk-jammy AS sysml-builder

ARG SYSML_API_REF=master
ENV SBT_VERSION=1.9.9 \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install sbt (the Play build tool) from the official sbt release tarball.
RUN set -eux; \
    curl -fsSL --retry 3 \
      "https://github.com/sbt/sbt/releases/download/v${SBT_VERSION}/sbt-${SBT_VERSION}.tgz" \
      -o /tmp/sbt.tgz; \
    tar -xzf /tmp/sbt.tgz -C /opt; \
    ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt; \
    rm /tmp/sbt.tgz

WORKDIR /build
RUN git clone --depth=1 --branch "${SYSML_API_REF}" \
      https://github.com/Systems-Modeling/SysML-v2-API-Services.git .

# Upstream persistence.xml already targets jdbc:postgresql://localhost:5432/sysml2
# (user "postgres"), which is exactly the loopback Postgres the runtime image
# provisions — no patching needed. The kernel uses hbm2ddl create-drop, so its
# schema is rebuilt on each boot.
#
# Produce the Play dist launcher (target/universal/stage/bin/<name>).
RUN sbt --batch --no-colors stage

# ── Stage 2: runtime ─────────────────────────────────────────
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
    MINIO_RELEASE=RELEASE.2024-10-13T13-34-11Z

# ── Base OS packages ─────────────────────────────────────────
# postgresql backs the SysML v2 kernel (loopback only). software-properties /
# add-apt-repository not needed: the distro postgresql package is sufficient.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3-pip \
      nginx \
      curl wget git ca-certificates gettext-base \
      supervisor unzip git-lfs openssh-client \
      postgresql postgresql-client \
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

# ── SysML v2 API Services (Play dist, internal :8003) ────────
# Copy the staged Play distribution built by the sysml-builder stage. The
# launcher lives at /opt/sysml/bin/sysml-v2-api-services and is started by
# supervisord with -Dhttp.port=${SYSML_JAVA_PORT}. It persists to the local
# loopback Postgres (program:sysml-db) using hbm2ddl create-drop.
COPY --from=sysml-builder /build/target/universal/stage /opt/sysml

# ── Local Postgres for the SysML kernel (loopback :5432) ─────
# The kernel's persistence.xml expects db "sysml2" / user "postgres". We
# initialise a fresh cluster at build time; data is ephemeral (create-drop on
# every kernel boot), so it intentionally does NOT live on EFS.
ENV PGDATA=/var/lib/postgresql/data \
    SYSML_DB_NAME=sysml2 \
    SYSML_DB_USER=postgres \
    SYSML_DB_PASSWORD=mysecretpassword
RUN set -eux; \
    PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"; \
    mkdir -p "$PGDATA" /var/run/postgresql; \
    chown -R postgres:postgres "$PGDATA" /var/run/postgresql; \
    su postgres -c "$PGBIN/initdb -D $PGDATA --auth=trust --username=$SYSML_DB_USER"; \
    echo "listen_addresses = '127.0.0.1'" >> "$PGDATA/postgresql.conf"; \
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -w start"; \
    su postgres -c "$PGBIN/createdb -O $SYSML_DB_USER $SYSML_DB_NAME"; \
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -w stop"

# ── Python sidecar venv (FastAPI health/metrics + proxy) ─────
RUN python3.11 -m venv /opt/sidecar-venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/sidecar-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# ── Config + entrypoints ─────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/forge-devops.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY api_wrapper.py /app/api_wrapper.py
COPY entrypoint.sh /usr/local/bin/forge-entrypoint.sh
COPY sysml-db.sh /usr/local/bin/forge-sysml-db.sh
COPY sysml-kernel.sh /usr/local/bin/forge-sysml-kernel.sh
COPY forgejo-app.ini.tmpl /etc/forgejo/app.ini.tmpl
RUN chmod +x /usr/local/bin/forge-entrypoint.sh \
             /usr/local/bin/forge-sysml-db.sh \
             /usr/local/bin/forge-sysml-kernel.sh && \
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
