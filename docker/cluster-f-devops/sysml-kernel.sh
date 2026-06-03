#!/usr/bin/env bash
# Launch the SysML v2 API Services Play dist after its loopback Postgres is
# accepting connections. The kernel rebuilds its schema on boot (create-drop),
# so it must not start before the DB is ready.
set -euo pipefail

PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"
DB_NAME="${SYSML_DB_NAME:-sysml2}"
DB_USER="${SYSML_DB_USER:-postgres}"
HTTP_PORT="${SYSML_JAVA_PORT:-8003}"

for _ in $(seq 1 60); do
  if "$PGBIN/pg_isready" -h 127.0.0.1 -p 5432 -d "$DB_NAME" -U "$DB_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Requests reach the kernel only over loopback from the FastAPI sidecar, so
# allow any Host header (Play's AllowedHostsFilter otherwise 400s proxied
# requests whose Host is rewritten to localhost:8003).
exec /opt/sysml/bin/sysml-v2-api-services \
  -Dhttp.port="$HTTP_PORT" \
  -Dpidfile.path=/dev/null \
  -Dplay.filters.hosts.allowed.0="."
