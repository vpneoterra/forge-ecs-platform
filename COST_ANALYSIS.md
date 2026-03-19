# FORGE Platform — Cost Analysis

## Summary

| Deployment Model | Monthly Cost | Notes |
|-----------------|-------------|-------|
| Naive (30+ Fargate tasks, always-on) | $4,000–$8,000 | 1 Fargate task per service |
| This optimized deployment (dev) | **$72–$116** | 8 consolidated EC2 Spot tasks |
| This deployment (prod, multi-AZ) | **$200–$400** | Multi-AZ RDS, bigger instances |
| Hibernating | **~$3–8** | Only S3/EFS/ECR storage |
| **Savings vs naive** | **95–98%** | |

---

## Dev Environment Breakdown

### Always-On Costs (Provider A)

| Resource | Spec | Cost/Month |
|---------|------|-----------|
| EC2 c6g.xlarge Spot (Graviton) | 4 vCPU, 8 GB RAM | ~$51 |
| Elastic IP (NAT) | Static public IP | $3.50 |
| NAT Instance t4g.nano Spot | 2 vCPU, 0.5 GB | ~$3 |
| **Provider A subtotal** | | **~$57.50** |

> With 1-year Compute Savings Plan on the c6g.xlarge: ~$36/month → total ~$43

### On-Demand Costs (Provider B — Heavy Compute)

Assumption: 1–2 person team, light usage

| Scenario | Hours/Month | Cost/Month |
|---------|------------|-----------|
| Minimal (light usage) | ~10 hrs | ~$4 |
| Typical (daily simulations) | ~40 hrs | ~$16 |
| Heavy (continuous runs) | ~150 hrs | ~$60 |

Provider B instance types (Spot pricing):
- c5.2xlarge (8 vCPU, 16 GB): ~$0.10/hr Spot
- c5.4xlarge (16 vCPU, 32 GB): ~$0.20/hr Spot
- m5.4xlarge (16 vCPU, 64 GB): ~$0.25/hr Spot

### GPU Costs (Provider C)

| Usage | Cost/Month |
|-------|-----------|
| 4 hrs/month (training) | ~$1.40 |
| 20 hrs/month | ~$7 |

g5.xlarge Spot: ~$0.35/hr

### Storage

| Resource | Size | Cost/Month |
|---------|------|-----------|
| S3 (Intelligent-Tiering, frequent) | 50 GB | $1.15 |
| S3 (deep archive after 6 months) | 100 GB | $0.23 |
| EFS (bursting, 5 GB active) | 5 GB | $1.50 |
| ECR (8 repos, 20 GB total) | 20 GB | $2.00 |
| EBS (root volumes, on-demand EC2) | 2 × 30 GB | $4.80 |
| **Storage subtotal** | | **~$9.68** |

### Managed Services

| Service | Usage | Cost/Month |
|---------|-------|-----------|
| DynamoDB (pay-per-request) | ~1M reads, 100K writes | ~$0 (free tier) |
| Step Functions | ~1K state transitions/day | ~$1 |
| CloudWatch Logs (7-day retention) | ~5 GB/month | ~$2.50 |
| CloudWatch Alarms (5 alarms) | 5 metric alarms | ~$0.50 |
| SNS (email alerts) | ~100 notifications | ~$0 |
| Route53 (optional) | Hosted zone | $0.50 |
| **Managed services subtotal** | | **~$4.50** |

### Total Dev Environment

| Category | Min | Typical | Heavy |
|---------|-----|---------|-------|
| Always-on (Provider A) | $57 | $57 | $57 |
| Heavy compute (Provider B) | $4 | $16 | $60 |
| GPU (Provider C) | $0 | $1.40 | $7 |
| Storage | $10 | $10 | $15 |
| Managed services | $5 | $5 | $5 |
| RDS (if not using Supabase) | $12 | $12 | $12 |
| **TOTAL (with RDS)** | **$88** | **$101** | **$156** |
| **TOTAL (with Supabase, free)** | **$76** | **$89** | **$144** |

---

## Key Cost Decisions

### 1. NAT Instance vs NAT Gateway

| Option | Monthly Cost | Trade-off |
|--------|------------|-----------|
| NAT Gateway (AWS managed) | $32 + $0.045/GB | Zero management, HA |
| NAT Instance t4g.nano Spot | ~$3 | Single point of failure (but we have Spot fallback) |
| **Savings** | **$29/month** | Acceptable for dev — use NAT Gateway for prod HA |

### 2. Fargate vs EC2 Spot

| Option | Monthly Cost for forge-devops | Notes |
|--------|-----|-------|
| Fargate (4 vCPU, 8 GB) | ~$150/month | $0.04048/vCPU-hr + $0.004445/GB-hr |
| EC2 Spot c6g.xlarge shared | ~$51/month | 3 services on one instance |
| **Savings** | **~3× cheaper** | |

Fargate for all 8 tasks: **$400–$600/month** just for always-on compute.  
EC2 Spot shared instance: **$51/month** for 3 always-on tasks.

### 3. Redis vs DynamoDB

| Option | Monthly Cost | Notes |
|--------|-------------|-------|
| ElastiCache t4g.small | ~$13/month | Dedicated Redis cluster |
| DynamoDB pay-per-request | ~$0/month | Free tier: 25 GB, 25 WCU, 25 RCU |
| **Savings** | **$13/month** | DynamoDB sufficient for job state + simple caching |

### 4. Multi-AZ vs Single-AZ (dev)

| Option | Monthly Cost | Notes |
|--------|-------------|-------|
| Multi-AZ VPC (2 NAT Gateways) | +$64/month | HA for dev = overkill |
| Single-AZ | $0 extra | Acceptable downtime during Spot interruptions |
| **Savings** | **$64/month** | Use multi-AZ for prod only |

### 5. Service Consolidation

| Approach | ECS Tasks | Monthly Cost |
|----------|-----------|-------------|
| 1 task per service (30+ services) | 30+ tasks | $4,000–$8,000 |
| 8 consolidated mega-containers | 8 tasks | $72–$116 |
| **Reduction** | **73%** | **95–98% cost reduction** |

---

## Hibernate Mode

During hibernation (nights/weekends/vacation):

| Resource | Status | Cost |
|---------|--------|------|
| ECS instances (3 ASGs) | Stopped (0 instances) | $0 |
| NAT instance | Stopped | $0 |
| RDS | Stopped | $0 (stopped instances still billed for storage only) |
| S3 | Running | ~$1.15/month |
| EFS | Running (no active mounts) | ~$1.50/month |
| ECR | Running | ~$2/month |
| Elastic IP (unassociated) | Running | $3.65/month |
| DynamoDB | Running | ~$0 |
| **TOTAL hibernating** | | **~$8/month** |

```bash
# Hibernate when done for the day
./scripts/hibernate.sh

# Wake up when starting work
./scripts/wake.sh  # ~5 minutes to full operation
```

If you hibernate 50% of the month (12 hrs/day idle):
- Savings: ~$57/month × 50% = ~$28.50/month
- **Effective monthly cost: ~$44–$87/month**

---

## Prod Environment Estimate

Additional prod costs:
- Multi-AZ RDS (t4g.micro → t4g.small): +$10/month
- EFS multi-AZ mount targets: +$3/month
- CloudWatch (30-day retention): +$5/month
- Compute Savings Plan (c6g.xlarge, 1yr): saves $15/month
- ALB (if desired over Nginx): +$16/month

**Prod total: ~$200–$400/month** depending on compute usage.

---

## Comparison with Alternatives

| Alternative | Monthly Cost | Notes |
|-------------|-------------|-------|
| Self-hosted (on-prem server) | ~$200 (amortized) | Power, maintenance, hardware refresh |
| DigitalOcean Kubernetes | ~$200–$400 | Good but limited GPU/HPC options |
| GCP GKE Autopilot | ~$300–$600 | Higher base cost |
| Azure AKS | ~$300–$500 | Similar to GCP |
| AWS EKS (naive) | ~$400–$700 | EKS control plane $72 + node costs |
| **This deployment (AWS ECS)** | **$72–$116** | No EKS control plane fee, Spot pricing |

**Conclusion:** AWS ECS with aggressive Spot usage, bin-packing, and scale-to-zero is the cheapest
cloud option for a compute-intensive 1–2 person team.
