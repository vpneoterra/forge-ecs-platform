# forge-cluster-f-devops — consolidated DevOps task image

Single ARM64 (Graviton / Provider A) image that runs the real **SEL persistence
backend** for the FORGE web app: **Forgejo** (git), a real **SysML v2 API
kernel**, **MinIO** (object store), all fronted by **Nginx**, supervised by
`supervisord` (PID 1, via `initProcessEnabled` in the task def).

This follows the repo's *consolidated single-image* convention
(`lib/forge-compute-stack.ts` builds exactly one container per manifest entry).
Do not refactor this into multiple containers.

## Processes & ports

| Process      | Internal port | Public via         | Notes |
|--------------|---------------|--------------------|-------|
| nginx        | **80**        | task port 80       | `/healthz` (ECS health), `/git/`→Forgejo, `/sysml/`→SysML, `/minio/`→MinIO |
| sysml-api    | **9000**      | Cloud Map `:9000`  | FastAPI sidecar = `SYSML_API_PORT`; the public SysML surface |
| sysml-java   | 8003          | (internal only)    | Official `Systems-Modeling/SysML-v2-API-Services` Play dist (`SYSML_JAVA_PORT`) |
| sysml-db     | 5432          | (internal only)    | Loopback Postgres backing the SysML kernel (ephemeral, `create-drop`) |
| forgejo      | 3000          | nginx `/git/` + vhost `git.forge.local` | HTTP only; SSH optional |
| minio        | 9090 / 9091   | nginx `/minio/`    | S3 API / console; data root `/forge/minio` |

The SysML public port is **9000** to match `SYSML_API_PORT` in
`lib/config/solver-manifest.ts`. The Java backend stays internal on 8003 and the
sidecar proxies `9000 → 8003` (adapted from `forgenew/docker/sysml/Dockerfile`,
which had the roles reversed).

## Healthchecks

- **Task health (ECS):** `GET http://localhost:80/healthz` → `200 ok`.
- **SysML health:** `GET :9000/health` (sidecar) → `status: ok|degraded` plus
  `backend_available` reflecting the Java backend on 8003.
- **SysML metrics:** `GET :9000/metrics` (Prometheus text).
- Nginx `/healthz` returns 200 even while Forgejo/SysML are still warming, so the
  task becomes healthy quickly; subtab readiness should poll `:9000/health`.

## EFS layout (durable)

Two EFS access-point mounts are declared in the manifest and mounted by the task
definition:

| Container path | EFS access-point sourcePath | Used by |
|----------------|-----------------------------|---------|
| `/forge/repos` | `/forgejo`                  | Forgejo repos + SQLite db + LFS |
| `/forge/minio` | `/minio`                    | MinIO object store |

Forgejo `app.ini` sets `WORK_PATH=/forge/repos`, SQLite `PATH=/forge/repos/forgejo.db`,
repos under `/forge/repos/repositories`. So a task replacement keeps all git
history and objects.

## Secrets (injected at runtime, never baked in)

Wired via `lib/secret-lookup.ts` (`ecsSecretByName`) so the task def gets a
complete-ARN `valueFrom`:

| Env var (container) | Secrets Manager secret | Purpose |
|---------------------|------------------------|---------|
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `forge/minio/root` | MinIO root creds |
| `FORGEJO_ADMIN_TOKEN` | `forge/test/forgejo-pat` | Forgejo admin PAT for app-side API calls |

`forge/minio/root` may be a JSON secret with `username`/`password` keys (the task
def maps the two keys to the two env vars) or two separate secrets — see the
compute stack wiring.

## Cloud Map names the forge-app should use

The `forge-devops` ECS service registers on the `forge.local` namespace. Point
the app at:

- **Forgejo:** `http://forge-devops.forge.local/git/` (via nginx :80) — or, when
  a `git.forge.local` A/alias record is added, `http://git.forge.local/`.
- **SysML v2 API:** `http://forge-devops.forge.local:9000`
  (set `SEL_SYSML_API_BASE_URL` to this; `/health`, `/api/...`, `/run`).

## Build

ARM64 only. Two supported paths:

```bash
# A) Local / build-all.sh (uses this in-repo context)
./docker/build-all.sh forge-devops

# B) AWS CodeBuild (Graviton container, privilegedMode for buildx)
#    buildspec at docker/cluster-f-devops/buildspec.yml
aws codebuild start-build --project-name forge-devops-image
```

> **ECR repo name:** the running task pulls **`forge-devops`** (the task def uses
> `repositoryName = task.name`). `forge-cluster-f-devops` is the source/imageRepo
> name only. Both `build-all.sh` and `buildspec.yml` push to `forge-devops`.

## SysML v2 kernel build (sbt, multi-stage)

`Systems-Modeling/SysML-v2-API-Services` is a **Play Framework app built with
sbt** — it is *not* a Gradle project and publishes no release JAR (the old
release-JAR download 404'd and the `gradle shadowJar` fallback could never
work). The Dockerfile now builds it correctly:

- **Stage `sysml-builder`** (`eclipse-temurin:17-jdk-jammy` + sbt) clones the
  upstream repo and runs `sbt stage`, producing a self-contained Play
  distribution under `target/universal/stage/` with a
  `bin/sysml-v2-api-services` launcher.
- **Runtime stage** copies that staged dist into `/opt/sysml` and runs it on
  the arm64 temurin JRE. Java bytecode is arch-independent, so the JDK build
  on any arch runs natively on Graviton.
- Pin a specific tag with `--build-arg SYSML_API_REF=<tag>` (default `master`).

### Postgres decision

The kernel hardcodes a Postgres connection in `conf/META-INF/persistence.xml`
(`jdbc:postgresql://localhost:5432/sysml2`, user `postgres`) and uses Hibernate
`hbm2ddl=create-drop`, so its model store is **rebuilt on every boot**. Rather
than coupling `forge-devops` to the optional `ForgeDataStack` RDS instance
(which can be skipped via `skipRds=true` in favour of external Supabase), we run
a **loopback Postgres inside the image** (`program:sysml-db`, 127.0.0.1:5432).

This keeps the consolidated single-image convention (like the embedded Forgejo
and MinIO), works regardless of `skipRds`, and matches the kernel's ephemeral
`create-drop` semantics — so the DB intentionally does **not** live on EFS. The
FastAPI sidecar on :9000 is a thin proxy with no SysML logic of its own, so the
real Java kernel is required for the `/api/...` and `/run` surfaces the FORGE
SEL client calls.
