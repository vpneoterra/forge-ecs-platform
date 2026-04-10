#!/bin/bash
# Start the Gemma GPU instance for inference.
# vLLM auto-starts on boot (configured in user data).
# NLB health checks will detect the instance as healthy in ~2-3 minutes.
#
# Usage: ./scripts/gemma-wake.sh [environment]

set -euo pipefail

ENV="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"

echo "=== Starting Gemma GPU instance (forge-gemma-gpu-${ENV}) ==="

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=forge-gemma-gpu-${ENV}" "Name=instance-state-name,Values=stopped" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text \
  --region "$REGION")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "No stopped Gemma instance found for env=${ENV}"
  echo "It may already be running. Check with:"
  echo "  aws ec2 describe-instances --filters 'Name=tag:Name,Values=forge-gemma-gpu-${ENV}' --query 'Reservations[].Instances[].{ID:InstanceId,State:State.Name}' --output table"
  exit 0
fi

echo "Starting instance: $INSTANCE_ID"
aws ec2 start-instances --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "Waiting for instance to start..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

echo "✓ Gemma GPU instance running."
echo ""
echo "vLLM will take 2-5 minutes to load the model."
echo "Monitor via SSM:"
echo "  aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "  tail -f /var/log/vllm.log"
echo ""
echo "NLB health checks will mark it healthy automatically."
echo "Once healthy, the Model Router will route eligible calls to Gemma."
