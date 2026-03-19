#!/usr/bin/env bash
# FORGE Platform — Hibernate Script
# Reduces cost to ~$3/month by stopping all compute resources.
# Preserved: S3, DynamoDB, ECR (pennies), EFS (no active mounts = no charge beyond storage)
# Stopped:   ECS instances (ASGs scaled to 0), RDS stopped, NAT instance stopped
#
# Cost during hibernation:
#   EFS storage (~5 GB): $1.50/month
#   S3 storage (~50 GB): $1.15/month
#   DynamoDB:            ~$0/month (free tier)
#   ECR (~20 GB):        ~$2/month
#   Elastic IP (unused): $3.65/month
#   TOTAL:               ~$3-8/month
#
# Usage: ./scripts/hibernate.sh [dev|prod]
set -euo pipefail

FORGE_ENV="${1:-${FORGE_ENV:-dev}}"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║   FORGE Platform — Entering Hibernate Mode       ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════╝${NC}"
echo ""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CLUSTER="forge-${FORGE_ENV}"

# ── 1. Scale ECS services to 0 ────────────────────────────────────────────────
info "Scaling ECS services to desiredCount=0..."
for SERVICE in forge-lightweight forge-devops forge-monitoring; do
  aws ecs update-service \
    --cluster "${CLUSTER}" \
    --service "${SERVICE}" \
    --desired-count 0 \
    --region "${REGION}" \
    --output text --query 'service.serviceName' 2>/dev/null \
    && success "Scaled down: ${SERVICE}" \
    || warn "Service not found: ${SERVICE} (may already be stopped)"
done

# ── 2. Scale ASGs to 0 instances ──────────────────────────────────────────────
info "Scaling Auto Scaling Groups to 0..."
for PROVIDER_NAME in ForgeProviderA ForgeProviderB ForgeProviderC; do
  # Find the ASG associated with this capacity provider
  ASG_NAME=$(aws ecs describe-capacity-providers \
    --capacity-providers "${PROVIDER_NAME}" \
    --region "${REGION}" \
    --query 'capacityProviders[0].autoScalingGroupProvider.autoScalingGroupArn' \
    --output text 2>/dev/null | awk -F'/' '{print $NF}' || echo "")

  if [[ -n "${ASG_NAME}" && "${ASG_NAME}" != "None" ]]; then
    aws autoscaling update-auto-scaling-group \
      --auto-scaling-group-name "${ASG_NAME}" \
      --min-size 0 \
      --max-size 0 \
      --desired-capacity 0 \
      --region "${REGION}" 2>/dev/null \
      && success "ASG scaled to 0: ${ASG_NAME}" \
      || warn "Failed to scale ASG: ${ASG_NAME}"
  fi
done

# ── 3. Stop NAT instance ──────────────────────────────────────────────────────
info "Stopping NAT instance..."
NAT_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:Name,Values=forge-nat-${FORGE_ENV}" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [[ -n "${NAT_INSTANCE_ID}" && "${NAT_INSTANCE_ID}" != "None" ]]; then
  aws ec2 stop-instances \
    --instance-ids "${NAT_INSTANCE_ID}" \
    --region "${REGION}" \
    --output text --query 'StoppingInstances[0].InstanceId' >/dev/null
  success "NAT instance stopped: ${NAT_INSTANCE_ID}"
  warn "NOTE: Stopped Elastic IP still costs \$3.65/month when not associated with running instance"
else
  warn "NAT instance not found or already stopped"
fi

# ── 4. Stop RDS (if running) ──────────────────────────────────────────────────
info "Stopping RDS instance..."
RDS_ID=$(aws rds describe-db-instances \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'forge')].DBInstanceIdentifier | [0]" \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [[ -n "${RDS_ID}" && "${RDS_ID}" != "None" ]]; then
  aws rds stop-db-instance \
    --db-instance-identifier "${RDS_ID}" \
    --region "${REGION}" \
    --output text --query 'DBInstance.DBInstanceStatus' >/dev/null 2>/dev/null \
    && success "RDS stopped: ${RDS_ID}" \
    || warn "RDS already stopped or not found: ${RDS_ID}"
else
  info "No RDS instance found (using external DB or not deployed)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Hibernate Complete — Cost: ~\$3-8/month         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "Resources preserved (minimal cost):"
echo "  • S3 bucket data (Intelligent-Tiering)"
echo "  • DynamoDB table (pay-per-request, ~\$0 when idle)"
echo "  • ECR images (~\$2/month)"
echo "  • EFS data (no access charges when not mounted)"
echo ""
info "To resume: ./scripts/wake.sh ${FORGE_ENV}"
echo ""
