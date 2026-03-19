# forge-ecs-platform

Cost-optimized AWS ECS deployment for the FORGE fusion engineering platform.
**Target cost: $72–$116/month** for a 1–2 person team (vs $4,000–$8,000/month naive deployment).

---

## Architecture

```
                         Internet
                             │
                    ┌────────▼────────┐
                    │   Elastic IP    │  $3.50/month
                    │  (forge-devops  │
                    │  Nginx entry)   │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │         VPC 10.0.0.0/16     │
              │                             │
              │  ┌─────────────────────┐    │
              │  │   Public Subnet     │    │
              │  │  NAT t4g.nano Spot  │ $3 │
              │  └──────────┬──────────┘    │
              │             │               │
              │  ┌──────────▼──────────┐    │
              │  │   Private Subnet    │    │
              │  │                     │    │
              │  │  ┌───────────────┐  │    │
              │  │  │ c6g.xlarge    │  │    │    Provider A
              │  │  │ Graviton Spot │  │ $51│    (always-on)
              │  │  │               │  │    │
              │  │  │ forge-light   │  │    │  ← CadQuery, Paramak, PicoGK
              │  │  │ forge-devops  │  │    │  ← Nginx, Forgejo, MinIO, SysML
              │  │  │ forge-monitor │  │    │  ← Prometheus, Grafana
              │  │  └───────────────┘  │    │
              │  │                     │    │
              │  │  ┌───────────────┐  │    │    Provider B
              │  │  │ c5.2xlarge+   │  │$0-40    (scale-to-zero)
              │  │  │ x86 Spot      │  │    │
              │  │  │               │  │    │  ← VMEC++, OpenMC, PROCESS
              │  │  │ forge-hpc     │  │    │  ← Elmer, CalculiX, OpenFOAM
              │  │  │ forge-fem-cfd │  │    │  ← SIMSOPT, BOOZ_XFORM
              │  │  │ forge-st-*    │  │    │  ← Bluemira, ParaStell
              │  │  └───────────────┘  │    │
              │  └─────────────────────┘    │
              │                             │
              │  S3  EFS  DynamoDB  ECR  RDS│
              └─────────────────────────────┘
```

---

## Quick Start

**3 commands to deploy:**

```bash
# 1. Clone this repo
git clone https://github.com/vpneoterra/forge-ecs-platform.git
cd forge-ecs-platform

# 2. Configure AWS credentials
aws configure

# 3. Deploy (dev environment, no RDS — uses Supabase)
SKIP_RDS=true ./scripts/deploy.sh dev
```

That's it. Takes ~10 minutes on first deploy.

---

## Cost Breakdown

| Component | Monthly Cost |
|-----------|-------------|
| Provider A: c6g.xlarge Spot (always-on) | $51 |
| Provider B: ~40 hrs heavy compute/month | $8–40 |
| Provider C: ~4 hrs GPU/month | $1.40 |
| NAT Instance (t4g.nano Spot) | $3 |
| Elastic IP | $3.50 |
| RDS t4g.micro (or Supabase: $0) | $0–12 |
| S3 (~50 GB, Intelligent-Tiering) | $1.15 |
| EFS (~5 GB, bursting) | $1.50 |
| ECR (~20 GB, 8 repos) | $2 |
| CloudWatch Logs (7-day retention) | $3 |
| Step Functions (~1000 transitions/day) | $1 |
| DynamoDB (free tier) | $0 |
| **TOTAL (dev, no RDS)** | **$72–$116** |
| **With Savings Plan on Provider A** | **$60–$100** |
| **Hibernating** | **~$3–8** |

**Naive comparison:** 30+ individual ECS Fargate tasks = **$4,000–$8,000/month**  
**This deployment:** **$72–$116/month = 95–98% savings**

---

## Service Consolidation Map

| Task | Provider | CPU | RAM | Services Inside |
|------|----------|-----|-----|-----------------|
| forge-lightweight | A (always-on) | 2 vCPU | 3.75 GB | CadQuery, Paramak, ParaStell, PicoGK, Stellarator Orchestrator |
| forge-devops | A (always-on) | 4 vCPU | 7 GB | Nginx, forge-app, Forgejo, MinIO, SysML API, SysON |
| forge-monitoring | A (always-on) | 1 vCPU | 1.75 GB | Prometheus, Grafana, Alertmanager, Node Exporter, cAdvisor |
| forge-stellarator-config | A (SQS-driven) | 4 vCPU | 4 GB | DESC, pyQSC, pyQIC |
| forge-hpc | B (SQS-driven) | 8 vCPU | 16 GB | PROCESS, VMEC++, OpenMC |
| forge-fem-cfd | B (SQS-driven) | 16 vCPU | 32 GB | Elmer, CalculiX, OpenFOAM, Gmsh |
| forge-stellarator-coils | B (SQS-driven) | 6 vCPU | 8 GB | SIMSOPT, VMEC++, BOOZ_XFORM |
| forge-stellarator-cad | B (SQS-driven) | 4 vCPU | 4 GB | Bluemira, ParaStell, Paramak |

---

## GitHub Actions Setup

Add these secrets to your repository (`Settings → Secrets → Actions`):

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `GH_PAT` | GitHub PAT for cloning source repos (build-images.yml) |

### Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy.yml` | Push to `main` or manual | CDK deploy to dev/prod |
| `build-images.yml` | Weekly Monday or manual | Build & push Docker images to ECR |

### Manual Deploy

```bash
# Deploy to dev
gh workflow run deploy.yml -f environment=dev

# Deploy to prod with Supabase instead of RDS
gh workflow run deploy.yml -f environment=prod -f skipRds=true -f alertEmail=you@example.com

# Build specific image
gh workflow run build-images.yml -f target_image=forge-hpc
```

---

## Hibernate / Wake

**Hibernate** — reduce to ~$3/month when not in use:
```bash
./scripts/hibernate.sh
```
This stops: all ECS instances, NAT instance, RDS.  
Preserved: S3 data, DynamoDB, ECR images, EFS data.

**Wake** — restore full operation in ~5 minutes:
```bash
./scripts/wake.sh
```

---

## File Structure

```
forge-ecs-platform/
├── bin/
│   └── forge-ecs-platform.ts    # CDK app entry point
├── lib/
│   ├── config/
│   │   ├── solver-manifest.ts   # 8 consolidated task definitions
│   │   └── capacity-providers.ts # Provider A/B/C configs
│   ├── forge-network-stack.ts   # VPC + NAT instance + security groups
│   ├── forge-data-stack.ts      # S3 + EFS + RDS + ECR + DynamoDB
│   ├── forge-compute-stack.ts   # ECS cluster + tasks + services
│   └── forge-orchestration-stack.ts # Step Functions + EventBridge + CloudWatch
├── scripts/
│   ├── deploy.sh                # Local deployment
│   ├── destroy.sh               # Full teardown
│   ├── hibernate.sh             # Scale to near-zero
│   └── wake.sh                  # Restore from hibernate
├── docker/
│   └── build-all.sh             # Build & push all Docker images
├── .github/workflows/
│   ├── deploy.yml               # CI/CD deploy
│   └── build-images.yml         # Weekly image refresh
├── package.json
├── tsconfig.json
├── cdk.json
├── README.md
├── AI_CONTEXT.md
└── COST_ANALYSIS.md
```

---

## Stacks

| Stack | Description |
|-------|-------------|
| `ForgeNetwork-{env}` | VPC, public/private subnets, NAT instance, VPC endpoints, security groups |
| `ForgeData-{env}` | S3 bucket, EFS filesystem, RDS PostgreSQL, 8 ECR repos, DynamoDB |
| `ForgeCompute-{env}` | ECS cluster, 3 capacity providers, 8 task definitions, 3 ECS services, SQS queues |
| `ForgeOrchestration-{env}` | Step Functions (CEM loop + Stellarator pipeline), EventBridge, CloudWatch dashboard, SNS alerts |

---

## Monitoring

**CloudWatch Dashboard**: `forge-platform-health-dev`
- ECS CPU/memory utilization
- SQS queue depths (detect backlog)
- Step Functions execution counts
- Monthly cost estimate

**Alerts** (SNS → email):
- ECS task failures > 3/hour
- Monthly cost estimate > $300
- Any SQS DLQ message (failed job)
- Spot interruption events

---

## Source Repositories

| Image | Source Repo |
|-------|-------------|
| forge-lightweight | [vpneoterra/forge-cluster-a-geometry](https://github.com/vpneoterra/forge-cluster-a-geometry) |
| forge-devops | [vpneoterra/forge-cluster-f-devops](https://github.com/vpneoterra/forge-cluster-f-devops) |
| forge-monitoring | [vpneoterra/forge-cluster-c-observability](https://github.com/vpneoterra/forge-cluster-c-observability) |
| forge-hpc | [vpneoterra/forge-cluster-b-hpc](https://github.com/vpneoterra/forge-cluster-b-hpc) |
| forge-fem-cfd | [vpneoterra/forge-cluster-d-fem](https://github.com/vpneoterra/forge-cluster-d-fem) |
| forge-stellarator-config | [vpneoterra/forge-stellarator-config](https://github.com/vpneoterra/forge-stellarator-config) |
| forge-stellarator-coils | [vpneoterra/forge-stellarator-coils](https://github.com/vpneoterra/forge-stellarator-coils) |
| forge-stellarator-cad | [vpneoterra/forge-stellarator-cad](https://github.com/vpneoterra/forge-stellarator-cad) |

---

## CDK Context Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `env` | `dev` | Environment (`dev` or `prod`) |
| `skipRds` | `false` | Skip RDS — use external Supabase |
| `alertEmail` | `ops@forge.local` | Email for CloudWatch alerts |

```bash
# Dev with Supabase (cheapest)
npx cdk deploy --all -c env=dev -c skipRds=true -c alertEmail=you@example.com

# Prod with RDS
npx cdk deploy --all -c env=prod -c alertEmail=you@example.com
```

---

## License

MIT
