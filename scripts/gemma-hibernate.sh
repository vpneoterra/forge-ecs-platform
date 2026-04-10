#!/bin/bash
# Stop the Gemma GPU instance to save costs.
# When stopped, the Gemma circuit breaker opens and all calls fall back to Claude.
# Cost: $0/hr when stopped (only EBS storage: ~$8/month)
#
# Usage: ./scripts/gemma-hibernate.sh [environment]

set -euo pipefail

ENV="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"

echo "=== Stopping Gemma GPU instance (forge-gemma-gpu-${ENV}) ==="

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=forge-gemma-gpu-${ENV}" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text \
  --region "$REGION")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "No running Gemma instance found for env=${ENV}"
  exit 0
fi

echo "Stopping instance: $INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "Waiting for instance to stop..."
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "✓ Gemma GPU instance stopped. Circuit breaker will route all calls to Claude."
echo "  To restart: ./scripts/gemma-wake.sh ${ENV}"
