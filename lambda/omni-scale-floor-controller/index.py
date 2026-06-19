# ─── omni-scale-floor-controller (UNIFIED OMNI control brain) ─────────────────
# The SINGLE OMNI scaling brain. CDK-managed continuation of the out-of-band
# `omni-backlog-metric` Lambda's purpose-built OMNI control model, with the
# off-zero floor job folded in so there is exactly ONE brain. Runs every minute
# and does BOTH jobs from ONE authoritative read of omni.render_jobs:
#
#   (A) PUBLISH OMNI/Render -> BacklogPerTask (DIMENSIONLESS):
#         BacklogPerTask = (queued + running) / max(runningTaskCount, 1)
#       runningTaskCount is the omni-${env} ECS service runningCount
#       (DescribeServices) -- the SAME denominator the legacy omni-backlog-metric
#       Lambda used. This is the OMNI-specific signal the native step policy
#       consumes. The render worker does NOT publish BacklogPerTask (it emits a
#       SEPARATE, ServiceName-dimensioned observability set), so this Lambda is
#       the SOLE publisher -- no collision; the step policy reads this stream.
#
#   (B) SET the scalable-target FLOOR (minCapacity) so the fleet can leave ZERO.
#       At desiredCount=0 no task runs and the native step policy is blind to new
#       work, so the policy alone can never lift the fleet off zero. This Lambda
#       closes that cold-start gap by RAISING minCapacity from the queue depth.
#       When the queue drains it drops the floor to 0 and the policy scales in.
#
# WHY A FLOOR (not desiredCount): AWS docs are explicit that with an active
# scaling policy on a service, Application Auto Scaling can REVERT a desiredCount
# you set manually (via UpdateService) whenever an alarm fires. Adjusting
# minCapacity via RegisterScalableTarget cooperates with the policy instead of
# fighting it: ASG always honours minCapacity, and the native policy is free to
# scale within [floor, max].
#
# FLOOR MATH (WARM_SLOTS=1 -> one task serves one render at a time):
#     need  = queued + running            # total live work units in the queue
#     floor = clamp(need - WARM_SLOTS, 0, MAX)
# WARM_SLOTS=1 accounts for the always-on `forge-omni` warm floor that absorbs the
# first unit of work; MAX is the burst fleet's maxCapacity (OMNI_MAX_TASKS=120, a
# CEILING -- the floor tracks live work so the fleet never creeps idly to the
# cap). When need <= WARM_SLOTS the floor is 0 and the burst fleet returns to 0.
#
# QUEUE DEPTH SOURCE: the EXACT same definition the worker uses
# (PostgresRenderJobStore.GetQueueStats) -- ONE source of truth shared by the
# worker, this brain, and PR A's claimable queue, replacing the legacy Lambda's
# separate bom_omni_render_jobs/fresh-window read:
#     SELECT COUNT(*) FILTER (WHERE status='queued')  AS queued,
#            COUNT(*) FILTER (WHERE status='running') AS running
#       FROM omni.render_jobs;
# Stale orphans cannot inflate the signal: the reclaim sweep fails expired leases
# OUT of 'running', so only genuinely live work is counted (the same intent as the
# legacy Lambda's fresh-window orphan exclusion, enforced by queue state instead).
#
# FAIL-LOUD: any error (secret fetch, DB connect, query, ECS describe, metric
# put, register) is logged at ERROR and re-raised so the invocation is marked
# FAILED and visible in CloudWatch/alarms. We do NOT swallow errors to "pass" --
# a broken probe must never emit a misleading 0 that triggers scale-in during a
# real backlog, nor silently leave the fleet stuck at zero under load.
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
_ecs = boto3.client("ecs")
_cw = boto3.client("cloudwatch")


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _running_task_count() -> int:
    # ECS service runningCount -- the BacklogPerTask denominator, identical to the
    # legacy omni-backlog-metric Lambda. Fail loud if the service is missing so a
    # broken probe never emits a misleading metric.
    cluster = os.environ["OMNI_ECS_CLUSTER"]
    service = os.environ["OMNI_ECS_SERVICE"]
    resp = _ecs.describe_services(cluster=cluster, services=[service])
    svcs = resp.get("services", [])
    if not svcs:
        raise RuntimeError(f"ECS service {cluster}/{service} not found")
    return int(svcs[0].get("runningCount", 0))


def _publish_backlog_per_task(queued: int, running: int, running_tasks: int) -> float:
    # (A) Publish the OMNI-specific scaling signal the native step policy consumes.
    # BacklogPerTask = live work units / running tasks. DIMENSIONLESS on purpose:
    # the step policy reads the dimensionless stream, and the worker publishes a
    # SEPARATE ServiceName-dimensioned observability set (never BacklogPerTask),
    # so this is the sole publisher of this metric -- no collision.
    namespace = os.environ.get("OMNI_METRIC_NAMESPACE", "OMNI/Render")
    metric_name = os.environ.get("OMNI_METRIC_NAME", "BacklogPerTask")
    backlog = queued + running
    per_task = backlog / max(running_tasks, 1)
    _cw.put_metric_data(
        Namespace=namespace,
        MetricData=[{
            "MetricName": metric_name,
            "Value": float(per_task),
            "Unit": "Count",
        }],
    )
    return per_task


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
    max_tasks = int(os.environ.get("OMNI_MAX_TASKS", "120"))
    warm_slots = int(os.environ.get("OMNI_WARM_SLOTS", "1"))

    queued, running = _read_queue_depth()
    need = queued + running
    desired_floor = _clamp(need - warm_slots, 0, max_tasks)

    # (A) Publish BacklogPerTask EVERY tick so the native step policy always has a
    # fresh signal -- done before the floor decision and unconditionally (even on
    # a floor no-op), since the step policy reacts to this metric continuously.
    running_tasks = _running_task_count()
    per_task = _publish_backlog_per_task(queued, running, running_tasks)

    current = _current_floor()
    if current == desired_floor:
        logger.info(
            "no-op: queued=%d running=%d running_tasks=%d backlog_per_task=%.3f "
            "need=%d warm=%d floor=%d (unchanged)",
            queued, running, running_tasks, per_task, need, warm_slots, desired_floor,
        )
        return {
            "queued": queued, "running": running, "running_tasks": running_tasks,
            "backlog_per_task": per_task, "need": need,
            "floor": desired_floor, "changed": False,
        }

    _set_floor(desired_floor, max_tasks)
    logger.info(
        "set floor: queued=%d running=%d running_tasks=%d backlog_per_task=%.3f "
        "need=%d warm=%d floor %s -> %d (max=%d)",
        queued, running, running_tasks, per_task, need, warm_slots,
        current, desired_floor, max_tasks,
    )
    return {
        "queued": queued, "running": running, "running_tasks": running_tasks,
        "backlog_per_task": per_task, "need": need,
        "floor": desired_floor, "previous_floor": current, "changed": True,
    }
