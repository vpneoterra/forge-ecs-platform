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
| sysml-java   | 8003          | (internal only)    | Official `Systems-Modeling/SysML-v2-API-Services` JAR (`SYSML_JAVA_PORT`) |
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

## Known caveat — SysML JAR at build time

The official SysML v2 API Services project does not always publish a release JAR;
the Dockerfile falls back to a Gradle `shadowJar` build from source. That fallback
needs network egress to GitHub + Gradle and a JDK (this image uses a JRE base, so
the Gradle path additionally relies on the cloned project's wrapper if the system
`gradle` install is insufficient). **This has not been verified to succeed on
arm64 in this sandbox (no Docker/AWS).** If the build fails at the SysML stage,
the operator should either (a) supply a prebuilt `sysml-v2-api-services.jar` in
the build context, or (b) switch the SysML stage to a JDK base image. Java
bytecode itself is arch-independent, so a successfully-built JAR runs on Graviton.
