# AI_CONTEXT.md — FORGE ECS Platform

Machine-readable context for AI assistants working on this codebase.

## Project Purpose
AWS CDK TypeScript project deploying the FORGE fusion engineering platform to ECS.
Optimized for minimum cost: $72–$116/month for 1–2 person team.

## Key Decisions

### Cost optimizations
- 30+ services consolidated into 8 ECS tasks (mega-containers)
- NAT Instance (t4g.nano Spot, $3/month) instead of NAT Gateway ($32/month)
- No Redis — DynamoDB free tier for job state and caching
- S3 Intelligent-Tiering instead of manual lifecycle rules
- RDS t4g.micro ($12/month) or skip entirely (use Supabase = $0)
- Scale-to-zero for all heavy compute (Provider B starts at 0 instances)
- Single c6g.xlarge Graviton Spot handles all always-on services

### Architecture
- 5+ CDK stacks: Network → Data → Compute → Orchestration + Geometry (optional)
- Provider A: Graviton ARM Spot (c6g.xlarge) — always-on services
- Provider B: x86 Spot (c5.2xlarge/c5.4xlarge) — scale-to-zero heavy compute
- Provider C: GPU Spot (g5.xlarge) — pay-per-use only
- SQS FIFO queues trigger ECS RunTask for scale-to-zero jobs
- Step Functions manages CEM loop and Stellarator pipeline
- Cloud Map (forge.local) for service discovery between always-on services

### Technology choices
- aws-cdk-lib v2 (single package)
- TypeScript 5.6 with strict mode
- ECS EC2 (not Fargate — EC2 Spot is 70-90% cheaper)
- EFS bursting (no provisioned throughput cost)
- DynamoDB pay-per-request (free tier covers usage)

## File Map

| File | Purpose |
|------|---------|
| `bin/forge-ecs-platform.ts` | CDK app entry — creates stacks based on context flags |
| `lib/config/solver-manifest.ts` | All 8 task configs (cpu, memory, env vars) |
| `lib/config/capacity-providers.ts` | Provider A/B/C instance type configs |
| `lib/forge-network-stack.ts` | VPC + NAT instance + security groups |
| `lib/forge-data-stack.ts` | S3 + EFS + RDS + ECR + DynamoDB |
| `lib/forge-compute-stack.ts` | ECS cluster + capacity providers + tasks + services |
| `lib/forge-orchestration-stack.ts` | Step Functions + EventBridge + CloudWatch |
| `lib/forge-geometry-stack.ts` | Geometry Platform: B-Rep, GPU SDF, Neural SDF |
| `lib/config/geometry-manifest.ts` | 5 geometry capability configs + feature flags |

## Service Consolidation

```
forge-lightweight    = CadQuery + Paramak + ParaStell + PicoGK + Stellarator Orchestrator
forge-devops         = Nginx + forge-app + Forgejo + MinIO + SysML API + SysON
forge-monitoring     = Prometheus + Grafana + Alertmanager + Node Exporter + cAdvisor
forge-stellarator-config = DESC + pyQSC + pyQIC
forge-hpc            = PROCESS + VMEC++ + OpenMC
forge-fem-cfd        = Elmer + CalculiX + OpenFOAM + Gmsh
forge-stellarator-coils = SIMSOPT + VMEC++ + BOOZ_XFORM
forge-stellarator-cad   = Bluemira + ParaStell + Paramak
```

## Key CDK Patterns Used

```typescript
// ASG Capacity Provider (L2 construct for managed EC2 capacity)
const asg = new autoscaling.AutoScalingGroup(...)
const provider = new ecs.AsgCapacityProvider(this, 'ProviderA', { autoScalingGroup: asg })
cluster.addAsgCapacityProvider(provider)

// ECS Service with capacity provider strategy
new ecs.Ec2Service(this, 'Service', {
  capacityProviderStrategies: [{ capacityProvider: provider.name, weight: 1, base: 1 }]
})

// Spot via MixedInstancesPolicy on ASG
mixedInstancesPolicy: {
  instancesDistribution: { onDemandPercentageAboveBaseCapacity: 0 }
}
```

## Environment Variables Injected at Runtime
- `AWS_REGION` — from CDK
- `S3_BUCKET` — forge-platform-data-{account}-{region}
- `DYNAMODB_TABLE` — forge-jobs
- `ECS_CLUSTER` — forge-{env}
- `SQS_QUEUE_URL` — per-task SQS FIFO URL (for scale-to-zero tasks)
- `DB_HOST` / `DB_PORT` — RDS endpoint (if RDS deployed)
- Service-specific vars from `SOLVER_MANIFEST[task].environment`

## CDK Context Variables
- `env` (dev|prod) — controls AZ count, RDS multi-AZ, container insights
- `deployApp` (true|false) — deploy ForgeAppStack (Fargate web app)
- `deployOmni` (true|false) — deploy OMNI PicoGK standalone
- `deployDks` (true|false) — deploy DKS in ForgeAppStack
- `deployGemma` (true|false) — deploy Gemma GPU inference
- `deployGeometry` (true|false) — deploy Geometry Platform
- `deploySolvers` (true|false) — deploy full Compute + Orchestration
- `skipRds` (true|false) — skip RDS, use external Supabase
- `alertEmail` — SNS subscription email

## Geometry Platform

Five capabilities, double-gated (service desiredCount + feature flag env var).
All deploy OFF. Operator activates per runbook.

| # | Capability | Container | Flag | Status |
|---|-----------|-----------|------|--------|
| 1 | B-Rep / STEP Engine | forge-brep (:5090) Fargate | BREP_ENGINE_ENABLED | Ready to activate |
| 2 | GPU SDF Engine | forge-sdf-gpu (:5080) EC2 GPU | GPU_SDF_ENABLED | Dormant (task def only) |
| 3 | Neural SDF Engine | forge-neural-sdf (:5100) EC2 GPU | NEURAL_SDF_ENABLED | Dormant (task def only) |
| 4 | Visual ASG Editor | None (client-side JS) | ASG_EDITOR_ENABLED | Ready to activate |
| 5 | Field-Driven TPMS | None (uses FluxTK) | FIELD_DRIVEN_ENABLED | Ready to activate |

Activation: `aws ecs update-service --cluster forge-geometry-{env} --service forge-brep --desired-count 1`
then set `BREP_ENGINE_ENABLED=true` in forge-app env and restart.

## Estimated Stack Deploy Times (first run)
- ForgeNetwork: ~5 minutes (VPC + NAT instance)
- ForgeData: ~8 minutes (RDS takes longest if enabled)
- ForgeCompute: ~10 minutes (ASGs, ECS services)
- ForgeOrchestration: ~3 minutes
- ForgeGeometry: ~4 minutes (ECR + Fargate service + GPU task defs)
- Total: ~25 minutes first run, ~5 minutes updates
