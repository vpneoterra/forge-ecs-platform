#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# FORGE — Unified CloudWatch Monitoring Setup
# Implements all 10 steps from the FORGE Unified CloudWatch Setup Guide v1.0
#
# Usage:
#   chmod +x forge-cloudwatch-setup.sh
#   ./forge-cloudwatch-setup.sh [--dry-run] [--step N]
#
# Prerequisites:
#   - AWS CLI v2 configured with credentials (us-east-1)
#   - IAM permissions: logs:*, cloudwatch:*, sns:*, s3:*, events:*
#   - The FORGE ECS service must be running (log groups must exist)
#
# Options:
#   --dry-run    Print commands without executing
#   --step N     Run only step N (1-10)
#   --skip-sns   Skip SNS topic creation (if it already exists)
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
REGION="us-east-1"
LOG_GROUP_APP="/forge/ecs/forge-app-test"
LOG_GROUP_OMNI="/forge/ecs/forge-omni"
S3_BUCKET="forge-cem-assets"
NAMESPACE="FORGE/Platform"
DASHBOARD_NAME="FORGE-Unified"
SNS_TOPIC_NAME="forge-alerts"
ALERT_EMAIL="vpacha@qrucible.ai"
ACCOUNT_ID="266087050444"
SNS_TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${SNS_TOPIC_NAME}"
RETENTION_DAYS=30

# ── Parse Arguments ───────────────────────────────────────────────────────────
DRY_RUN=false
STEP_ONLY=""
SKIP_SNS=false

for arg in "$@"; do
  case $arg in
    --dry-run)   DRY_RUN=true ;;
    --step)      shift; STEP_ONLY="$1" ;;
    --skip-sns)  SKIP_SNS=true ;;
  esac
done

run_cmd() {
  if [ "$DRY_RUN" = true ]; then
    echo "[DRY-RUN] $*"
  else
    echo "[EXEC] $*"
    eval "$@"
  fi
}

should_run() {
  [ -z "$STEP_ONLY" ] || [ "$STEP_ONLY" = "$1" ]
}

echo "═══════════════════════════════════════════════════════════════"
echo " FORGE Unified CloudWatch Setup"
echo " Region: ${REGION}"
echo " Log Group: ${LOG_GROUP_APP}"
echo " Namespace: ${NAMESPACE}"
echo " Dry Run: ${DRY_RUN}"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: Set Log Retention
# ══════════════════════════════════════════════════════════════════════════════
if should_run 1; then
  echo "─── Step 1: Set Log Retention (${RETENTION_DAYS} days) ───"

  run_cmd "aws logs put-retention-policy \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --retention-in-days ${RETENTION_DAYS}"

  # Only set OMNI retention if the log group exists
  if aws logs describe-log-groups --region ${REGION} --log-group-name-prefix ${LOG_GROUP_OMNI} --query 'logGroups[0].logGroupName' --output text 2>/dev/null | grep -q forge-omni; then
    run_cmd "aws logs put-retention-policy \
      --region ${REGION} \
      --log-group-name ${LOG_GROUP_OMNI} \
      --retention-in-days ${RETENTION_DAYS}"
  else
    echo "[SKIP] Log group ${LOG_GROUP_OMNI} not found — skipping retention policy"
  fi

  echo "✓ Step 1 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: Create Metric Filters
# ══════════════════════════════════════════════════════════════════════════════
if should_run 2; then
  echo "─── Step 2: Create Metric Filters ───"

  # Filter 1: I2D Run Start Count
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-i2d-run-start \
    --filter-pattern '\"AIN-PHASE-SNAPSHOT\" \"interpret\"' \
    --metric-transformations \
      metricName=I2DRunStartCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  # Filter 2: Claude API Error Count
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-claude-errors \
    --filter-pattern '\"ARGUS-TRANSCRIPT\" \"failed\"' \
    --metric-transformations \
      metricName=ClaudeAPIErrorCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  # Filter 3: I2D Phase Failure Count
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-i2d-phase-failure \
    --filter-pattern '\"AIN-PHASE-SNAPSHOT\" \"failed\"' \
    --metric-transformations \
      metricName=I2DPhaseFailureCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  # Filter 4: Application Error Count
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-app-errors \
    --filter-pattern '\"ERROR\"' \
    --metric-transformations \
      metricName=AppErrorCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  # Filter 5: S3 Flush Events
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-s3-flush \
    --filter-pattern '\"flushed\" \"S3\"' \
    --metric-transformations \
      metricName=S3FlushCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  # Filter 6: Meridian Events (provisional — update pattern once confirmed)
  run_cmd "aws logs put-metric-filter \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --filter-name forge-meridian-events \
    --filter-pattern '\"meridian\"' \
    --metric-transformations \
      metricName=MeridianEventCount,metricNamespace=${NAMESPACE},metricValue=1,defaultValue=0"

  echo "✓ Step 2 complete — 6 metric filters created"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: Create SNS Topic + Email Subscription
# ══════════════════════════════════════════════════════════════════════════════
if should_run 3; then
  echo "─── Step 3: Create SNS Topic ───"

  if [ "$SKIP_SNS" = true ]; then
    echo "[SKIP] SNS creation skipped (--skip-sns flag)"
  else
    run_cmd "aws sns create-topic \
      --region ${REGION} \
      --name ${SNS_TOPIC_NAME} \
      --output text"

    run_cmd "aws sns subscribe \
      --region ${REGION} \
      --topic-arn ${SNS_TOPIC_ARN} \
      --protocol email \
      --notification-endpoint ${ALERT_EMAIL}"

    echo ""
    echo "⚠  CHECK YOUR EMAIL: Confirm the SNS subscription at ${ALERT_EMAIL}"
    echo "   Alarms will not deliver until the subscription is confirmed."
  fi

  echo "✓ Step 3 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Create CloudWatch Alarms
# ══════════════════════════════════════════════════════════════════════════════
if should_run 4; then
  echo "─── Step 4: Create CloudWatch Alarms ───"

  # Alarm 1: I2D Phase Failure Rate
  run_cmd "aws cloudwatch put-metric-alarm \
    --region ${REGION} \
    --alarm-name forge-i2d-phase-failure \
    --namespace ${NAMESPACE} \
    --metric-name I2DPhaseFailureCount \
    --statistic Sum \
    --period 300 \
    --threshold 5 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --alarm-actions ${SNS_TOPIC_ARN} \
    --alarm-description 'More than 5 I2D phase failures in 10 minutes' \
    --treat-missing-data notBreaching"

  # Alarm 2: Claude API Error Rate
  run_cmd "aws cloudwatch put-metric-alarm \
    --region ${REGION} \
    --alarm-name forge-claude-api-errors \
    --namespace ${NAMESPACE} \
    --metric-name ClaudeAPIErrorCount \
    --statistic Sum \
    --period 300 \
    --threshold 10 \
    --comparison-operator GreaterThanThreshold \
    --evaluation-periods 2 \
    --alarm-actions ${SNS_TOPIC_ARN} \
    --alarm-description 'More than 10 Claude API failures in 10 minutes' \
    --treat-missing-data notBreaching"

  # Alarm 3: S3 Flush Stagnation
  run_cmd "aws cloudwatch put-metric-alarm \
    --region ${REGION} \
    --alarm-name forge-s3-flush-stalled \
    --namespace ${NAMESPACE} \
    --metric-name S3FlushCount \
    --statistic Sum \
    --period 21600 \
    --threshold 0 \
    --comparison-operator LessThanOrEqualToThreshold \
    --evaluation-periods 1 \
    --treat-missing-data breaching \
    --alarm-actions ${SNS_TOPIC_ARN} \
    --alarm-description 'No S3 flushes in 6 hours — possible buffer stagnation'"

  echo "✓ Step 4 complete — 3 alarms created"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Create CloudWatch Dashboard
# ══════════════════════════════════════════════════════════════════════════════
if should_run 5; then
  echo "─── Step 5: Create CloudWatch Dashboard ───"

  # Detect ALB ARN automatically
  ALB_ARN=$(aws elbv2 describe-load-balancers \
    --region ${REGION} \
    --query "LoadBalancers[?contains(LoadBalancerName, 'forge') || contains(LoadBalancerName, 'Forge')].LoadBalancerArn" \
    --output text 2>/dev/null || echo "")

  if [ -z "$ALB_ARN" ]; then
    echo "[WARN] No FORGE ALB found — 5xx widget will use placeholder. Update manually."
    ALB_DIMENSION="app/forge-placeholder/placeholder"
  else
    # Extract the ALB dimension string (everything after loadbalancer/)
    ALB_DIMENSION=$(echo "$ALB_ARN" | sed 's|.*loadbalancer/||')
    echo "[INFO] Found ALB: ${ALB_DIMENSION}"
  fi

  DASHBOARD_BODY=$(cat <<DASHBOARD_EOF
{
  "widgets": [
    {
      "type": "metric", "x": 0, "y": 0, "width": 6, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "I2DRunStartCount", {"stat": "Sum", "period": 86400}]],
        "title": "I2D Runs (24h)", "view": "singleValue", "region": "${REGION}"
      }
    },
    {
      "type": "metric", "x": 6, "y": 0, "width": 6, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "ClaudeAPIErrorCount", {"stat": "Sum", "period": 3600}]],
        "title": "Claude Errors (1h)", "view": "singleValue", "region": "${REGION}",
        "yAxis": {"left": {"min": 0}}
      }
    },
    {
      "type": "metric", "x": 12, "y": 0, "width": 6, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "MeridianEventCount", {"stat": "Sum", "period": 86400}]],
        "title": "Meridian Events (24h)", "view": "singleValue", "region": "${REGION}"
      }
    },
    {
      "type": "metric", "x": 18, "y": 0, "width": 6, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "S3FlushCount", {"stat": "Sum", "period": 86400}]],
        "title": "S3 Flushes (24h)", "view": "singleValue", "region": "${REGION}"
      }
    },
    {
      "type": "metric", "x": 0, "y": 4, "width": 12, "height": 6,
      "properties": {
        "metrics": [
          ["${NAMESPACE}", "I2DRunStartCount", {"stat": "Sum", "period": 300, "label": "I2D Runs"}],
          ["${NAMESPACE}", "I2DPhaseFailureCount", {"stat": "Sum", "period": 300, "label": "Phase Failures"}],
          ["${NAMESPACE}", "ClaudeAPIErrorCount", {"stat": "Sum", "period": 300, "label": "Claude Errors"}]
        ],
        "title": "I2D Pipeline Activity (5m intervals)",
        "view": "timeSeries", "stacked": false, "region": "${REGION}",
        "yAxis": {"left": {"min": 0}}, "period": 300
      }
    },
    {
      "type": "metric", "x": 12, "y": 4, "width": 12, "height": 6,
      "properties": {
        "metrics": [
          ["${NAMESPACE}", "AppErrorCount", {"stat": "Sum", "period": 300, "label": "App Errors"}],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", "${ALB_DIMENSION}", {"stat": "Sum", "period": 60, "label": "5xx"}]
        ],
        "title": "Error Rates",
        "view": "timeSeries", "stacked": false, "region": "${REGION}",
        "yAxis": {"left": {"min": 0}}
      }
    },
    {
      "type": "log", "x": 0, "y": 10, "width": 24, "height": 6,
      "properties": {
        "query": "SOURCE '${LOG_GROUP_APP}' | fields @timestamp, @message, @logStream\n| filter @message like /error|Error|ERROR|failed|FAILED/\n| filter @message not like /favicon|static|console/\n| sort @timestamp desc\n| limit 25",
        "region": "${REGION}",
        "title": "Recent Errors (Live)",
        "view": "table"
      }
    },
    {
      "type": "log", "x": 0, "y": 16, "width": 12, "height": 6,
      "properties": {
        "query": "SOURCE '${LOG_GROUP_APP}' | fields @timestamp, @message\n| filter @message like /AIN-PHASE-SNAPSHOT/\n| sort @timestamp desc\n| limit 20",
        "region": "${REGION}",
        "title": "Recent I2D Phase Snapshots",
        "view": "table"
      }
    },
    {
      "type": "log", "x": 12, "y": 16, "width": 12, "height": 6,
      "properties": {
        "query": "SOURCE '${LOG_GROUP_APP}' | fields @timestamp, @message\n| filter @message like /ARGUS-TRANSCRIPT/\n| sort @timestamp desc\n| limit 20",
        "region": "${REGION}",
        "title": "Recent Argus Transcripts",
        "view": "table"
      }
    },
    {
      "type": "metric", "x": 0, "y": 22, "width": 12, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "S3FlushCount", {"stat": "Sum", "period": 900}]],
        "title": "S3 Flush Activity (15m intervals)",
        "view": "timeSeries", "region": "${REGION}",
        "yAxis": {"left": {"min": 0}}
      }
    },
    {
      "type": "metric", "x": 12, "y": 22, "width": 12, "height": 4,
      "properties": {
        "metrics": [["${NAMESPACE}", "MeridianEventCount", {"stat": "Sum", "period": 300}]],
        "title": "Meridian Activity (5m intervals)",
        "view": "timeSeries", "region": "${REGION}",
        "yAxis": {"left": {"min": 0}}
      }
    }
  ]
}
DASHBOARD_EOF
)

  run_cmd "aws cloudwatch put-dashboard \
    --region ${REGION} \
    --dashboard-name ${DASHBOARD_NAME} \
    --dashboard-body '$(echo "$DASHBOARD_BODY" | tr -d '\n' | sed "s/'/'\\\\''/g")'"

  echo ""
  echo "  Dashboard URL: https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=${DASHBOARD_NAME}"
  echo "✓ Step 5 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6: Save Logs Insights Queries (output query definitions)
# ══════════════════════════════════════════════════════════════════════════════
if should_run 6; then
  echo "─── Step 6: Save Logs Insights Queries ───"
  echo ""
  echo "NOTE: CloudWatch Logs Insights saved queries must be created via the"
  echo "      AWS Console or the put-query-definition API. Creating them now."
  echo ""

  # Query 1: I2D All Events
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-I2D-AllEvents' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message, @logStream
| filter @message like /i2d|I2D|design-studio|AIN-PHASE-SNAPSHOT|ARGUS-TRANSCRIPT/
| sort @timestamp desc
| limit 200'"

  # Query 2: I2D Phase Snapshots
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-I2D-PhaseSnapshots' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message
| filter @message like /AIN-PHASE-SNAPSHOT/
| sort @timestamp asc
| limit 100'"

  # Query 3: I2D Claude Calls
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-I2D-ClaudeCalls' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message
| filter @message like /ARGUS-TRANSCRIPT/
| filter @message like /i2d/
| sort @timestamp asc
| limit 100'"

  # Query 4: I2D Failures
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-I2D-Failures' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message
| filter @message like /ARGUS-TRANSCRIPT/
| filter @message like /failed|fallback|empty_response/
| sort @timestamp desc
| limit 50'"

  # Query 5: Meridian All Events
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-Meridian-AllEvents' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message, @logStream
| filter @message like /(?i)meridian/
| sort @timestamp desc
| limit 200'"

  # Query 6: Meridian Claude Calls
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-Meridian-ClaudeCalls' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message
| filter @message like /ARGUS-TRANSCRIPT/
| filter @message like /(?i)meridian/
| sort @timestamp asc
| limit 100'"

  # Query 7: All Errors
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-AllErrors' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message, @logStream
| filter @message like /error|Error|ERROR/
| filter @message not like /favicon|static|console/
| sort @timestamp desc
| limit 100'"

  # Query 8: S3 Flushes
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-S3Flushes' \
    --log-group-names '${LOG_GROUP_APP}' \
    --query-string 'fields @timestamp, @message
| filter @message like /flush|Flush|FLUSH/
| filter @message like /S3|s3/
| sort @timestamp desc
| limit 50'"

  # Query 9: Cross-Group Errors (app + omni)
  CROSS_GROUPS="${LOG_GROUP_APP}"
  if aws logs describe-log-groups --region ${REGION} --log-group-name-prefix ${LOG_GROUP_OMNI} --query 'logGroups[0].logGroupName' --output text 2>/dev/null | grep -q forge-omni; then
    CROSS_GROUPS="${LOG_GROUP_APP}' '${LOG_GROUP_OMNI}"
  fi
  run_cmd "aws logs put-query-definition \
    --region ${REGION} \
    --name 'FORGE-CrossGroup-Errors' \
    --log-group-names '${CROSS_GROUPS}' \
    --query-string 'fields @timestamp, @message, @logStream, @log
| filter @message like /error|Error|ERROR/
| sort @timestamp desc
| limit 100'"

  echo "✓ Step 6 complete — 9 saved queries created"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 7: Enable S3 EventBridge Notifications
# ══════════════════════════════════════════════════════════════════════════════
if should_run 7; then
  echo "─── Step 7: Enable S3 EventBridge Notifications ───"

  run_cmd "aws s3api put-bucket-notification-configuration \
    --region ${REGION} \
    --bucket ${S3_BUCKET} \
    --notification-configuration '{\"EventBridgeConfiguration\": {}}'"

  echo "✓ Step 7 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8: Create EventBridge Rule for S3 Design File Events
# ══════════════════════════════════════════════════════════════════════════════
if should_run 8; then
  echo "─── Step 8: Create EventBridge Rule for S3 Events ───"

  run_cmd "aws events put-rule \
    --region ${REGION} \
    --name forge-s3-design-files \
    --event-pattern '{
      \"source\": [\"aws.s3\"],
      \"detail-type\": [\"Object Created\"],
      \"detail\": {
        \"bucket\": {\"name\": [\"${S3_BUCKET}\"]},
        \"object\": {\"key\": [{\"prefix\": \"run-logs/\"}, {\"prefix\": \"monitor-logs/\"}]}
      }
    }'"

  echo ""
  echo "  NOTE: To emit a CloudWatch metric from this rule, attach a Lambda target"
  echo "  or use CloudWatch PutMetricData via an EventBridge input transformer."
  echo "  This rule currently has no target — add one manually or via CDK."
  echo "✓ Step 8 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 9: Create S3 Lifecycle Policy
# ══════════════════════════════════════════════════════════════════════════════
if should_run 9; then
  echo "─── Step 9: Create S3 Lifecycle Policy ───"

  # Check existing lifecycle config
  EXISTING=$(aws s3api get-bucket-lifecycle-configuration \
    --region ${REGION} \
    --bucket ${S3_BUCKET} 2>/dev/null || echo "{}")

  if echo "$EXISTING" | grep -q "ArchiveMonitorLogs"; then
    echo "[SKIP] Lifecycle rules already exist — skipping to avoid overwrite"
  else
    run_cmd "aws s3api put-bucket-lifecycle-configuration \
      --region ${REGION} \
      --bucket ${S3_BUCKET} \
      --lifecycle-configuration '{
        \"Rules\": [
          {
            \"ID\": \"ArchiveMonitorLogs\",
            \"Status\": \"Enabled\",
            \"Filter\": {\"Prefix\": \"monitor-logs/\"},
            \"Transitions\": [{\"Days\": 90, \"StorageClass\": \"GLACIER\"}],
            \"Expiration\": {\"Days\": 365}
          },
          {
            \"ID\": \"ArchiveRunLogs\",
            \"Status\": \"Enabled\",
            \"Filter\": {\"Prefix\": \"run-logs/\"},
            \"Transitions\": [{\"Days\": 90, \"StorageClass\": \"GLACIER\"}],
            \"Expiration\": {\"Days\": 365}
          }
        ]
      }'"
  fi

  echo "✓ Step 9 complete"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 10: Verification
# ══════════════════════════════════════════════════════════════════════════════
if should_run 10; then
  echo "─── Step 10: Verification ───"
  echo ""

  echo "Checking log group retention..."
  aws logs describe-log-groups \
    --region ${REGION} \
    --log-group-name-prefix /forge/ecs/ \
    --query 'logGroups[].{Name:logGroupName,RetentionDays:retentionInDays}' \
    --output table 2>/dev/null || echo "[WARN] Could not query log groups"

  echo ""
  echo "Checking metric filters..."
  aws logs describe-metric-filters \
    --region ${REGION} \
    --log-group-name ${LOG_GROUP_APP} \
    --query 'metricFilters[].{Name:filterName,Pattern:filterPattern}' \
    --output table 2>/dev/null || echo "[WARN] Could not query metric filters"

  echo ""
  echo "Checking alarms..."
  aws cloudwatch describe-alarms \
    --region ${REGION} \
    --alarm-name-prefix forge- \
    --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Metric:MetricName}' \
    --output table 2>/dev/null || echo "[WARN] Could not query alarms"

  echo ""
  echo "Checking dashboard..."
  aws cloudwatch list-dashboards \
    --region ${REGION} \
    --dashboard-name-prefix FORGE \
    --query 'DashboardEntries[].{Name:DashboardName,Size:Size}' \
    --output table 2>/dev/null || echo "[WARN] Could not query dashboards"

  echo ""
  echo "Checking saved queries..."
  aws logs describe-query-definitions \
    --region ${REGION} \
    --query-definition-name-prefix FORGE \
    --query 'queryDefinitions[].{Name:name}' \
    --output table 2>/dev/null || echo "[WARN] Could not query saved queries"

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo " VERIFICATION COMPLETE"
  echo ""
  echo " Dashboard: https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards:name=${DASHBOARD_NAME}"
  echo " Alarms:    https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#alarmsV2:"
  echo " Logs:      https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#logsV2:logs-insights"
  echo "═══════════════════════════════════════════════════════════════"
fi

echo ""
echo "Done. Run with --step 10 to verify all resources."
