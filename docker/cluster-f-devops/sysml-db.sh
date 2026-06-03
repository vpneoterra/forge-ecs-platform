#!/usr/bin/env bash
# Foreground launcher for the SysML kernel's loopback Postgres.
# Ensures the "sysml2" database exists, then execs postgres as PID of this
# supervised program. Data is ephemeral (kernel uses hbm2ddl create-drop).
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"
DB_NAME="${SYSML_DB_NAME:-sysml2}"
DB_USER="${SYSML_DB_USER:-postgres}"

chown -R postgres:postgres "$PGDATA" /var/run/postgresql 2>/dev/null || true

# Bootstrap the database once, using a temporary local server, before the
# long-lived foreground postgres takes over.
su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -w -o '-c listen_addresses=127.0.0.1' start"
if ! su postgres -c "$PGBIN/psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
  su postgres -c "$PGBIN/createdb -O '$DB_USER' '$DB_NAME'"
fi
su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -w stop"

exec su postgres -c "$PGBIN/postgres -D '$PGDATA'"
