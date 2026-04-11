# FORGE ECS Monitoring Roadmap

This document tracks the observability hooks implemented in the FORGE ECS platform
and the features planned for future sprints.

---

## Active Hooks (Implemented)

### 1. CloudWatch Logs
**Where:** `ForgeAppStack` — `ForgeAppLogGroup` (`/forge/ecs/forge-app-test`)  
**What:** All stdout/stderr from the `forge-app` container and the `forge-monitor-sidecar`
are shipped to CloudWatch Logs with a 7-day retention window.  
**Console:** CloudWatch → Log groups → `/forge/ecs/forge-app-test`

```bash
# Tail live logs
aws logs tail /forge/ecs/forge-app-test --follow --region us-east-1
```

---

### 2. Container Health Check + Circuit Breaker
**Where:** `ForgeAppStack` — `container` health check + `FargateService` `circuitBreaker: { rollback: true }`  
**What:**
- Docker health check polls `http://localhost:3000/health` every 30 s (3 retries, 60 s start period).
- ECS circuit breaker automatically rolls back to the previous task-definition revision if
  the new deployment fails to become healthy within the threshold window.

```bash
# Check service events (rollback messages appear here)
aws ecs describe-services \
  --cluster forge-app-dev \
  --services forge-app-test \
  --query 'services[0].events[:5]'
```

---

### 3. Deploy Verification (Post-Deploy Smoke Tests)
**Where:** GitHub Actions workflow (`.github/workflows/deploy.yml`)  
**What:** After `cdk deploy`, the workflow runs a lightweight HTTP smoke test against
`https://forge.qrucible.ai/health` and checks for a `200 OK`. Failures block the
pipeline before traffic is cut over.

---

### 4. CloudWatch 5xx Alarm
**Where:** `ForgeMonitoringStack` — `Forge5xxAlarm` (`forge-app-5xx-rate`)  
**What:** Fires when the ALB reports more than 10 `HTTPCode_Target_5XX_Count` events in
two consecutive 60-second windows. The alarm triggers an SNS notification to the
configured alert email(s).  
**Console:** CloudWatch → Alarms → `forge-app-5xx-rate`

```bash
# Check current alarm state
aws cloudwatch describe-alarms \
  --alarm-names forge-app-5xx-rate \
  --query 'MetricAlarms[0].StateValue'

# Manually trigger a test notification (ALARM state)
aws cloudwatch set-alarm-state \
  --alarm-name forge-app-5xx-rate \
  --state-value ALARM \
  --state-reason 'Manual test'
```

---

### 5. ECS Exec (Interactive Shell Access)
**Where:** `ForgeAppStack` — `FargateService` with `enableExecuteCommand: true`  
**What:** Allows ops engineers to open an interactive shell into any running task for
live debugging without SSH or bastion hosts. Requires `ssmmessages` IAM permissions
(already granted to the task role).

```bash
# Get a running task ARN
TASK=$(aws ecs list-tasks \
  --cluster forge-app-dev \
  --service-name forge-app-test \
  --query 'taskArns[0]' --output text)

# Open an interactive shell
aws ecs execute-command \
  --cluster forge-app-dev \
  --task "$TASK" \
  --container forge-app \
  --interactive \
  --command "/bin/sh"
```

---

### 6. Monitoring Sidecar Container
**Where:** `ForgeAppStack` — `forge-monitor-sidecar` container in the `forge-app-test` task definition  
**What:** A non-essential `amazon/cloudwatch-agent:latest` sidecar runs alongside the
main `forge-app` container. Because `essential: false`, a sidecar crash does not restart
the task. The sidecar can be configured (via CW agent config) to poll
`http://localhost:3000` and push custom metrics.  
**Console:** CloudWatch Logs → `/forge/ecs/forge-app-test` → stream prefix `forge-monitor`

---

### 7. ALB Access Logs → S3
**Where:** `ForgeAppStack` — `AlbAccessLogs` S3 bucket  
**What:**
- Bucket name: `forge-alb-access-logs-{account}-{region}`
- All ALB requests are logged with the prefix `forge-app/`
- 90-day lifecycle expiry; server-side encryption (S3-managed); public access blocked
- Bucket name exported as CloudFormation output `ForgeAlbAccessLogBucket-{env}`

```bash
# List recent access log files
aws s3 ls s3://forge-alb-access-logs-$(aws sts get-caller-identity \
  --query Account --output text)-us-east-1/forge-app/ \
  --recursive | tail -20

# Download and inspect the latest log
aws s3 cp "$(aws s3 ls s3://forge-alb-access-logs-... --recursive \
  | sort | tail -1 | awk '{print $4}')" - | gzip -d | head -50
```

---

### 8. EventBridge ECS Task State Change Alerts
**Where:** `ForgeMonitoringStack` — EventBridge rule `forge-ecs-state-change` + Lambda  
**What:** Catches `ECS Task State Change` events for the `forge-app-dev` cluster.
The Lambda filters for unexpected `STOPPED` events (i.e., where `desiredStatus != STOPPED`,
indicating an OOM kill, crash, or Fargate interruption) and publishes a detailed SNS
notification with the task ARN, group, stopped reason, and container exit codes.  
**Console:** EventBridge → Rules → `forge-ecs-state-change`

```bash
# View recent Lambda invocations
aws logs tail /aws/lambda/forge-ecs-state-alert-dev --follow

# List recent ECS task state change events (last hour)
aws events list-rules --name-prefix forge-ecs-state-change

# Manually send a test event to verify the pipeline
aws events put-events --entries '[{
  "Source": "aws.ecs",
  "DetailType": "ECS Task State Change",
  "Detail": "{\"lastStatus\":\"STOPPED\",\"desiredStatus\":\"RUNNING\",\"stoppedReason\":\"OutOfMemoryError\",\"taskArn\":\"arn:aws:ecs:us-east-1:123456789012:task/forge-app-dev/test\",\"clusterArn\":\"arn:aws:ecs:us-east-1:123456789012:cluster/forge-app-dev\",\"group\":\"service:forge-app-test\",\"containers\":[{\"name\":\"forge-app\",\"exitCode\":137}]}",
  "EventBusName": "default"
}]'
```

---

## Planned / Future Hooks

### X-Ray Distributed Tracing
**Status:** Planned — requires app-side instrumentation  
**Why not yet:** AWS X-Ray tracing requires the Node.js application to import the
`@aws-sdk/client-xray` or `aws-xray-sdk-node` package and wrap outbound HTTP calls.
Until the app is instrumented, the X-Ray daemon sidecar would collect no meaningful
traces.

**When ready, add to `ForgeAppStack`:**
```typescript
// X-Ray sidecar (add after forge-monitor-sidecar)
taskDef.addContainer('xray-daemon', {
  image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon:latest'),
  essential: false,
  portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }],
  memoryReservationMiB: 32,
  logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'xray' }),
});

// Add to task role:
taskRole.addToPolicy(new iam.PolicyStatement({
  actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
  resources: ['*'],
}));
```

**App-side (Node.js):**
```typescript
// At the very top of your server entry point:
import AWSXRay from 'aws-xray-sdk-core';
import http from 'http';
AWSXRay.captureHTTPsGlobal(http);
```

---

### Container Insights (ECS Cluster-Level Metrics)
**Status:** Deferred — cost vs. value tradeoff  
**Note:** `containerInsights: false` in `ForgeAppStack` keeps CloudWatch costs low for
dev. Enable in prod by setting `containerInsights: true` on the cluster construct.

---

### CloudWatch Composite Alarm
**Status:** Planned  
**What:** A composite alarm combining the 5xx alarm + ECS task count alarm, reducing
alert noise and enabling single-pane-of-glass incident triage.

---

### Synthetics Canary (Heartbeat)
**Status:** Planned  
**What:** A CloudWatch Synthetics canary that hits `https://forge.qrucible.ai/health`
every minute from outside the VPC, providing end-to-end reachability monitoring
independent of the internal health-check path.

---

## Quick Reference

### AWS Console Links

| Resource | Console path |
|---|---|
| ECS Service | ECS → Clusters → `forge-app-dev` → Services → `forge-app-test` |
| CloudWatch Logs | CloudWatch → Log groups → `/forge/ecs/forge-app-test` |
| CloudWatch Alarms | CloudWatch → Alarms → `forge-app-5xx-rate` |
| SNS Topic | SNS → Topics → `forge-deploy-alerts` |
| EventBridge Rule | EventBridge → Rules → `forge-ecs-state-change` |
| Lambda | Lambda → Functions → `forge-ecs-state-alert-dev` |
| ALB Access Logs | S3 → `forge-alb-access-logs-{account}-{region}` |

### Useful CLI Commands

```bash
# Describe running tasks
aws ecs list-tasks \
  --cluster forge-app-dev \
  --service-name forge-app-test \
  --output table

# Force a new deployment (triggers rolling update + circuit breaker)
aws ecs update-service \
  --cluster forge-app-dev \
  --service forge-app-test \
  --force-new-deployment

# Check current 5xx count (last 5 minutes)
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$(aws cloudformation describe-stacks \
    --stack-name ForgeApp-dev \
    --query "Stacks[0].Outputs[?OutputKey=='AlbFullName'].OutputValue" \
    --output text) \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 \
  --statistics Sum

# Subscribe a new email to the alert topic
aws sns subscribe \
  --topic-arn $(aws cloudformation describe-stacks \
    --stack-name ForgeMonitoring-dev \
    --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArn'].OutputValue" \
    --output text) \
  --protocol email \
  --notification-endpoint new-oncall@example.com
```

---

## Intervention Playbook Summary

| Signal | Likely cause | First action |
|---|---|---|
| 5xx alarm fires | App crash, bad deploy, upstream timeout | Check ECS events; compare task revision; rollback if new deploy |
| EventBridge task-stopped alert | OOM kill (exitCode 137), Spot interruption | Check `stoppedReason`; increase memory if OOM; retry if Spot |
| Health check failing (no alarm) | App not started yet | Check CloudWatch Logs for startup errors |
| ALB `502 Bad Gateway` | No healthy targets in target group | ECS service at 0 tasks; check circuit breaker state |
| Deployment stuck (circuit breaker) | New image unhealthy | `aws ecs describe-services` → events; check container health |

> **Circuit breaker rollback:** CDK configures `circuitBreaker: { rollback: true }`, so a
> failed deployment automatically reverts to the previous task definition revision.
> You will see a `(service forge-app-test) has started 1 tasks: ...` rollback event in the
> ECS service events log.
