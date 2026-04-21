"""
FORGE Tier-2 Testing Harness — Auto-Pause Lambda

Subscribed to the harness budget SNS topic. When AWS Budgets fires a
threshold alert (50/80/100% of the USD 50 monthly ceiling, scoped to
CostCenter=forge-testing-harness), this Lambda pauses the harness by:

  1. Scaling the harness ECS service to desiredCount=0
  2. Stopping any RUNNING or PENDING tasks in the harness cluster

It is scoped strictly to the harness cluster/service — it does not
touch OMNI, app, solver, data, or any other stack. IAM on the Lambda
role is limited to the harness cluster/service/task ARNs (see
forge-testing-harness-stack.ts).

Environment:
  HARNESS_CLUSTER_NAME   (required) ECS cluster name
  HARNESS_SERVICE_NAME   (required) ECS service name
  AUTO_PAUSE_ENABLED     "true"|"false" (default "true"). When "false"
                         the Lambda logs the event but takes no action.
                         Allows operators to disable auto-pause without
                         redeploying.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

ecs = boto3.client("ecs")

CLUSTER = os.environ["HARNESS_CLUSTER_NAME"]
SERVICE = os.environ["HARNESS_SERVICE_NAME"]
ENABLED = os.environ.get("AUTO_PAUSE_ENABLED", "true").lower() == "true"


def _scale_service_to_zero() -> dict[str, Any]:
    LOG.info("update_service desiredCount=0 cluster=%s service=%s", CLUSTER, SERVICE)
    resp = ecs.update_service(cluster=CLUSTER, service=SERVICE, desiredCount=0)
    return {
        "serviceArn": resp["service"]["serviceArn"],
        "desiredCount": resp["service"]["desiredCount"],
    }


def _stop_running_tasks() -> list[str]:
    stopped: list[str] = []
    for status in ("RUNNING", "PENDING"):
        token = None
        while True:
            kwargs: dict[str, Any] = {"cluster": CLUSTER, "desiredStatus": status}
            if token:
                kwargs["nextToken"] = token
            page = ecs.list_tasks(**kwargs)
            for arn in page.get("taskArns", []):
                try:
                    ecs.stop_task(
                        cluster=CLUSTER,
                        task=arn,
                        reason="Harness auto-pause: budget threshold breached",
                    )
                    stopped.append(arn)
                    LOG.info("stopped task %s", arn)
                except ClientError as exc:
                    LOG.warning("stop_task failed for %s: %s", arn, exc)
            token = page.get("nextToken")
            if not token:
                break
    return stopped


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    LOG.info("auto-pause invoked: %s", json.dumps(event, default=str))

    subject = ""
    message = ""
    records = event.get("Records") or []
    if records:
        sns = records[0].get("Sns") or {}
        subject = sns.get("Subject") or ""
        message = sns.get("Message") or ""

    if not ENABLED:
        LOG.info("AUTO_PAUSE_ENABLED=false — logging only, no action taken")
        return {
            "status": "disabled",
            "subject": subject,
            "message_preview": message[:256],
        }

    result: dict[str, Any] = {
        "status": "ok",
        "cluster": CLUSTER,
        "service": SERVICE,
        "subject": subject,
    }
    try:
        result["service"] = _scale_service_to_zero()
    except ClientError as exc:
        LOG.error("update_service failed: %s", exc)
        result["status"] = "partial"
        result["update_service_error"] = str(exc)

    result["stopped_tasks"] = _stop_running_tasks()
    LOG.info("auto-pause complete: %s", json.dumps(result, default=str))
    return result
