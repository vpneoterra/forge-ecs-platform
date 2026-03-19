#!/usr/bin/env bash
# FORGE Platform — Wake Script
# Reverses hibernate — brings all services back online in ~5 minutes.
# Usage: ./scripts/wake.sh [dev|prod]
set -euo pipefail

FORGE_ENV="${1:-${FORGE_ENV:-dev}}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   FORGE Platform — Waking Up                     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

CLUSTER="forge-${FORGE_ENV}"

# ── 1. Start NAT instance ─────────────────────────────────────────────────────
info "Starting NAT instance..."
NAT_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:Name,Values=forge-nat-${FORGE_ENV}" \
    "Name=instance-state-name,Values=stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [[ -n "${NAT_INSTANCE_ID}" && "${NAT_INSTANCE_ID}" != "None" ]]; then
  aws ec2 start-instances \
    --instance-ids "${NAT_INSTANCE_ID}" \
    --region "${REGION}" \
    --output text --query 'StartingInstances[0].InstanceId' >/dev/null
  success "NAT instance starting: ${NAT_INSTANCE_ID}"

  info "Waiting for NAT instance to be running..."
  aws ec2 wait instance-running \
    --instance-ids "${NAT_INSTANCE_ID}" \
    --region "${REGION}"
  success "NAT instance running"
else
  warn "NAT instance not found in stopped state (may already be running)"
fi

# ── 2. Start RDS ──────────────────────────────────────────────────────────────
info "Starting RDS instance..."
RDS_ID=$(aws rds describe-db-instances \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'forge')].DBInstanceIdentifier | [0]" \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [[ -n "${RDS_ID}" && "${RDS_ID}" != "None" ]]; then
  RDS_STATUS=$(aws rds describe-db-instances \
    --db-instance-identifier "${RDS_ID}" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text \
    --region "${REGION}" 2>/dev/null || echo "unknown")

  if [[ "${RDS_STATUS}" == "stopped" ]]; then
    aws rds start-db-instance \
      --db-instance-identifier "${RDS_ID}" \
      --region "${REGION}" \
      --output text --query 'DBInstance.DBInstanceStatus' >/dev/null
    success "RDS starting: ${RDS_ID} (takes ~3 minutes)"
    # Note: Don't wait for RDS — it takes too long. ECS will retry connections.
  else
    info "RDS status: ${RDS_STATUS} (no action needed)"
  fi
else
  info "No RDS instance found (using external DB or not deployed)"
fi

# ── 3. Scale ASG A back to min capacity ───────────────────────────────────────
info "Scaling Provider A ASG to min capacity..."
for PROVIDER_NAME in ForgeProviderA; do
  ASG_NAME=$(aws ecs describe-capacity-providers \
    --capacity-providers "${PROVIDER_NAME}" \
    --region "${REGION}" \
    --query 'capacityProviders[0].autoScalingGroupProvider.autoScalingGroupArn' \
    --output text 2>/dev/null | awk -F'/' '{print $NF}' || echo "")

  if [[ -n "${ASG_NAME}" && "${ASG_NAME}" != "None" ]]; then
    aws autoscaling update-auto-scaling-group \
      --auto-scaling-group-name "${ASG_NAME}" \
      --min-size 1 \
      --max-size 2 \
      --desired-capacity 1 \
      --region "${REGION}" 2>/dev/null \
      && success "ASG restored: ${ASG_NAME}" \
      || warn "Failed to restore ASG: ${ASG_NAME}"
  fi
done

# ── 4. Scale ECS services to desired count ────────────────────────────────────
info "Waiting 90s for EC2 instance to register with ECS..."
sleep 90

info "Scaling ECS services to desiredCount=1..."
for SERVICE in forge-lightweight forge-devops forge-monitoring; do
  aws ecs update-service \
    --cluster "${CLUSTER}" \
    --service "${SERVICE}" \
    --desired-count 1 \
    --region "${REGION}" \
    --output text --query 'service.serviceName' 2>/dev/null \
    && success "Service resumed: ${SERVICE}" \
    || warn "Service not found: ${SERVICE}"
done

# ── 5. Wait for services to stabilize ────────────────────────────────────────
info "Waiting for services to stabilize (up to 5 minutes)..."
aws ecs wait services-stable \
  --cluster "${CLUSTER}" \
  --services forge-lightweight forge-devops forge-monitoring \
  --region "${REGION}" 2>/dev/null \
  && success "All services stable" \
  || warn "Services not yet stable — check ECS console in a few minutes"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   FORGE Platform is awake!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Services now running:"
echo "  • forge-lightweight  — Geometry + Stellarator orchestrator"
echo "  • forge-devops       — Nginx + Forgejo + MinIO + SysML"
echo "  • forge-monitoring   — Prometheus + Grafana + Alertmanager"
echo ""
info "Scale-to-zero services start automatically when SQS messages arrive"
echo ""
