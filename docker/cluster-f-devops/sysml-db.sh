#!/usr/bin/env bash
# Foreground launcher for the SysML kernel's loopback Postgres.
# The cluster and the "sysml2" database are created at image build time; this
# script just ensures ownership and execs postgres as the supervised PID.
# Data is ephemeral (the kernel uses hbm2ddl create-drop on every boot).
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"

chown -R postgres:postgres "$PGDATA" /var/run/postgresql 2>/dev/null || true

exec su postgres -c "$PGBIN/postgres -D '$PGDATA'"
