# ─── omni-scale-floor-controller ──────────────────────────────────────────────
# OMNI burst-tier WARM-FLOOR controller.
#
# WHY: the omni-${env} burst fleet is a scale-to-zero Fargate service. Its native
# Application Auto Scaling step policy scales on the OMNI/Render -> BacklogPerTask
# CloudWatch metric, but that metric is only published by RUNNING tasks. At
# desiredCount=0 no task is running, so BacklogPerTask is absent and the native
# policy can never scale the fleet OFF zero. This controller closes that
# cold-start gap by reading the AUTHORITATIVE queue depth directly from the shared
# Postgres render queue (omni.render_jobs) and RAISING the scalable-target floor
# (minCapacity) so the fleet can start. When the queue drains it drops the floor
# back to 0 and the native step policy scales the fleet back in.
#
# WHY A FLOOR (not desiredCount): AWS docs are explicit that with an active
# scaling policy on a service, Application Auto Scaling can REVERT a desiredCount
# you set manually (via UpdateService) whenever an alarm fires. Adjusting
# minCapacity via RegisterScalableTarget cooperates with the policy instead of
# fighting it: ASG always honours minCapacity, and the native policy is free to
# scale within [floor, max].
#
# FLOOR MATH (OMNI_RENDER_SLOTS=1 -> one task serves one render at a time):
#     need  = queued + running            # total live work units in the queue
#     floor = clamp(need - WARM_SLOTS, 0, MAX)
# WARM_SLOTS=1 accounts for the always-on `forge-omni` warm floor that absorbs the
# first unit of work; MAX is the burst fleet's maxCapacity. When need <= WARM_SLOTS
# the floor is 0 and the burst fleet is allowed to return to zero.
#
# QUEUE DEPTH SOURCE: the EXACT same definition the worker uses
# (PostgresRenderJobStore.GetQueueStats):
#     SELECT COUNT(*) FILTER (WHERE status='queued')  AS queued,
#            COUNT(*) FILTER (WHERE status='running') AS running
#       FROM omni.render_jobs;
#
# FAIL-LOUD: any error (secret fetch, DB connect, query, register) is logged at
# ERROR and re-raised so the invocation is marked FAILED and is visible in
# CloudWatch/alarms. We do NOT swallow errors to "pass" -- a controller that
# silently no-ops would leave the fleet stuck at zero under load.
# ──────────────────────────────────────────────────────────────────────────────
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import boto3
import pg8000.native  # pure-python Postgres driver, vendored alongside this file

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_secrets = boto3.client("secretsmanager")
_aas = boto3.client("application-autoscaling")


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _get_conn_string() -> str:
    arn = os.environ["OMNI_JOBS_DB_SECRET_ARN"]
    resp = _secrets.get_secret_value(SecretId=arn)
    secret = resp.get("SecretString")
    if not secret:
        raise RuntimeError(f"JOBS_DB secret {arn} has no SecretString")
    # The secret may be a raw connection string OR a JSON blob containing one.
    secret = secret.strip()
    if secret.startswith("{"):
        data = json.loads(secret)
        for key in ("JOBS_DB_CONNECTION_STRING", "connection_string", "url", "dsn"):
            if data.get(key):
                return str(data[key])
        raise RuntimeError("JOBS_DB secret JSON has no recognised connection-string key")
    return secret


# Parse a Postgres connection string / URL into pg8000.native kwargs. Supports
# both URI form (postgres://user:pass@host:port/db?sslmode=require) and libpq
# keyword form (Host=...;Port=...;Username=...;Password=...;Database=...).
def _parse_conn(cs: str) -> dict[str, Any]:
    cs = cs.strip()
    if cs.startswith("postgres://") or cs.startswith("postgresql://"):
        from urllib.parse import urlparse, unquote, parse_qs

        u = urlparse(cs)
        kwargs: dict[str, Any] = {
            "host": u.hostname,
            "port": u.port or 5432,
            "user": unquote(u.username) if u.username else None,
            "password": unquote(u.password) if u.password else None,
            "database": (u.path or "/").lstrip("/") or None,
        }
        q = parse_qs(u.query)
        sslmode = (q.get("sslmode", ["require"])[0]).lower()
        if sslmode not in ("disable", "allow"):
            import ssl as _ssl

            ctx = _ssl.create_default_context()
            # Supabase pooler presents a valid cert; keep verification on. If a
            # deployment needs to relax this it must do so explicitly, not here.
            kwargs["ssl_context"] = ctx
        return {k: v for k, v in kwargs.items() if v is not None}

    # libpq keyword form (Npgsql style: "Host=...;Port=...;...")
    parts = dict(
        re.split(r"\s*=\s*", kv, maxsplit=1)
        for kv in cs.split(";")
        if "=" in kv
    )
    parts = {k.strip().lower(): v.strip() for k, v in parts.items()}
    kwargs = {
        "host": parts.get("host") or parts.get("server"),
        "port": int(parts.get("port", "5432")),
        "user": parts.get("username") or parts.get("user") or parts.get("user id"),
        "password": parts.get("password"),
        "database": parts.get("database") or parts.get("dbname"),
    }
    ssl_mode = (parts.get("ssl mode") or parts.get("sslmode") or "require").lower()
    if ssl_mode not in ("disable", "allow"):
        import ssl as _ssl

        kwargs["ssl_context"] = _ssl.create_default_context()
    return {k: v for k, v in kwargs.items() if v is not None}


def _read_queue_depth() -> tuple[int, int]:
    table = os.environ.get("OMNI_RENDER_TABLE", "omni.render_jobs")
    # Validate the table identifier (schema.table, alnum/underscore only) so it
    # is safe to interpolate -- pg8000 cannot parameterise identifiers, and this
    # value comes from our own CDK env, not user input.
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*", table):
        raise RuntimeError(f"unsafe OMNI_RENDER_TABLE: {table!r}")

    conn_kwargs = _parse_conn(_get_conn_string())
    con = pg8000.native.Connection(**conn_kwargs)
    try:
        rows = con.run(
            "SELECT "
            "COUNT(*) FILTER (WHERE status = 'queued')  AS queued, "
            "COUNT(*) FILTER (WHERE status = 'running') AS running "
            f"FROM {table}"
        )
    finally:
        con.close()
    queued, running = int(rows[0][0]), int(rows[0][1])
    return queued, running


def _current_floor() -> int | None:
    ns = os.environ["OMNI_SERVICE_NAMESPACE"]
    rid = os.environ["OMNI_SCALABLE_RESOURCE_ID"]
    dim = os.environ["OMNI_SCALABLE_DIMENSION"]
    resp = _aas.describe_scalable_targets(
        ServiceNamespace=ns, ResourceIds=[rid], ScalableDimension=dim
    )
    targets = resp.get("ScalableTargets", [])
    if not targets:
        return None
    return int(targets[0]["MinCapacity"])


def _set_floor(floor: int, max_tasks: int) -> None:
    ns = os.environ["OMNI_SERVICE_NAMESPACE"]
    rid = os.environ["OMNI_SCALABLE_RESOURCE_ID"]
    dim = os.environ["OMNI_SCALABLE_DIMENSION"]
    # RegisterScalableTarget requires BOTH bounds; keep MaxCapacity pinned at the
    # fleet cap so we never widen it here.
    _aas.register_scalable_target(
        ServiceNamespace=ns,
        ResourceId=rid,
        ScalableDimension=dim,
        MinCapacity=floor,
        MaxCapacity=max_tasks,
    )


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    max_tasks = int(os.environ.get("OMNI_MAX_TASKS", "3"))
    warm_slots = int(os.environ.get("OMNI_WARM_SLOTS", "1"))

    queued, running = _read_queue_depth()
    need = queued + running
    desired_floor = _clamp(need - warm_slots, 0, max_tasks)

    current = _current_floor()
    if current == desired_floor:
        logger.info(
            "no-op: queued=%d running=%d need=%d warm=%d floor=%d (unchanged)",
            queued, running, need, warm_slots, desired_floor,
        )
        return {
            "queued": queued, "running": running, "need": need,
            "floor": desired_floor, "changed": False,
        }

    _set_floor(desired_floor, max_tasks)
    logger.info(
        "set floor: queued=%d running=%d need=%d warm=%d floor %s -> %d (max=%d)",
        queued, running, need, warm_slots, current, desired_floor, max_tasks,
    )
    return {
        "queued": queued, "running": running, "need": need,
        "floor": desired_floor, "previous_floor": current, "changed": True,
    }
