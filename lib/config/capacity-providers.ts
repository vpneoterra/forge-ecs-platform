/**
 * FORGE Capacity Provider Configurations
 * Three providers optimized for cost: Graviton Spot (always-on), x86 Spot (scale-to-zero), GPU Spot.
 */

export interface CapacityProviderConfig {
  /** Logical name used in CDK and CloudFormation */
  name: string;
  /** AWS instance type preferences in order */
  instanceTypes: string[];
  /** Whether to use Spot purchasing */
  spot: boolean;
  /** Minimum number of instances (0 = scale-to-zero) */
  minCapacity: number;
  /** Maximum number of instances */
  maxCapacity: number;
  /** ASG managed scaling target utilization % */
  targetCapacityPercent: number;
  /** ARM64 or x86_64 */
  architecture: 'arm64' | 'x86_64';
  /** ECS Optimized Bottlerocket AMI or Amazon Linux 2 */
  amiType: 'bottlerocket-arm64' | 'bottlerocket-x86' | 'amazon-linux2-arm64' | 'amazon-linux2';
  /** Human description */
  description: string;
  /** Estimated Spot price per hour (reference only) */
  estimatedSpotPricePerHour: number;
  /** Estimated monthly cost at min capacity */
  estimatedMonthlyMin: number;
  /** Estimated monthly cost at max capacity */
  estimatedMonthlyMax: number;
}

/**
 * Provider A: Graviton Spot, always-on.
 * Hosts the three always-on services: forge-devops (4 vCPU / 7 GB),
 * forge-lightweight (2 vCPU / 3.75 GB) and forge-monitoring (1 vCPU / 1.75 GB).
 * Total always-on footprint: 7 vCPU (7168 CPU units) / ~12.8 GB.
 *
 * A single c6g.xlarge is 4 vCPU / 8 GB (4096 CPU units), so the always-on set
 * does NOT fit on one host: forge-devops alone (4096 CPU) saturates an entire
 * c6g.xlarge. The set requires TWO c6g.xlarge instances (verified live: devops
 * pinned to one host at 0 remaining CPU; lightweight+monitoring on the second).
 *
 * minCapacity is therefore 2, not 1. The prior `minCapacity: 1` was a latent
 * misconfiguration: it let the ASG scale in (or a deploy recycle down) to a
 * single host that physically cannot place forge-devops (4096 CPU > 1024 free
 * on a host already running lightweight+monitoring), so the SysML kernel was
 * evicted and `forge-devops.forge.local` lost all Cloud Map instances
 * (ENOTFOUND) — the deploy-time enabler of the 2026-06-08 GREEN outage. Keeping
 * >=2 always-on Graviton hosts means an instance recycle never drops cluster
 * capacity below the always-on footprint, and ECS can immediately place the
 * forge-devops replacement on the surviving host.
 *
 * Spot price: ~$0.07/hr per instance -> ~$102/month for the 2 always-on hosts
 * (the fleet already runs 2 instances in steady state; this only corrects the
 * declared floor to match the real always-on footprint).
 */
export const PROVIDER_A: CapacityProviderConfig = {
  name: 'ForgeProviderA',
  instanceTypes: ['c6g.xlarge', 'c6g.large', 'm6g.xlarge', 'm7g.xlarge'],
  spot: true,
  minCapacity: 2,
  maxCapacity: 2,
  targetCapacityPercent: 80,
  architecture: 'arm64',
  amiType: 'bottlerocket-arm64',
  description: 'Graviton Spot for always-on services (devops, monitoring, lightweight)',
  estimatedSpotPricePerHour: 0.07,
  estimatedMonthlyMin: 102,
  estimatedMonthlyMax: 102,
};

/**
 * Provider B: x86 Spot, scale-to-zero.
 * Hosts heavy compute tasks: forge-hpc, forge-fem-cfd, forge-stellarator-coils, forge-stellarator-cad.
 * Mix of 8-vCPU and 16-vCPU instances for flexibility.
 * Min: 0 (no cost when idle). Max: 3 for burst parallelism.
 * Spot price: ~$0.30-$0.50/hr per instance.
 */
export const PROVIDER_B: CapacityProviderConfig = {
  name: 'ForgeProviderB',
  instanceTypes: [
    'c5.2xlarge',   // 8 vCPU, 16 GB
    'c5a.2xlarge',  // 8 vCPU, 16 GB (AMD)
    'c6i.2xlarge',  // 8 vCPU, 16 GB (Ice Lake)
    'm5.2xlarge',   // 8 vCPU, 32 GB (memory optimized)
    'c5.4xlarge',   // 16 vCPU, 32 GB (for fem-cfd)
    'c5a.4xlarge',  // 16 vCPU, 32 GB (AMD)
    'c6i.4xlarge',  // 16 vCPU, 32 GB
    'm5.4xlarge',   // 16 vCPU, 64 GB (for large FEM jobs)
  ],
  spot: true,
  minCapacity: 0,
  maxCapacity: 3,
  targetCapacityPercent: 100, // Aggressive bin-packing
  architecture: 'x86_64',
  amiType: 'bottlerocket-x86',
  description: 'x86 Spot for heavy compute (HPC, FEM/CFD, stellarator solvers). Scale-to-zero.',
  estimatedSpotPricePerHour: 0.40,
  estimatedMonthlyMin: 0,
  estimatedMonthlyMax: 288,
};

/**
 * Provider C: GPU Spot, pay-per-use only.
 * Hosts: Modulus, DeepXDE, PINN training jobs.
 * Min: 0 (no instances unless training triggered).
 * g5.xlarge: 1x A10G GPU, 4 vCPU, 16 GB.
 * Spot price: ~$0.34/hr -> $1.40 at 4 hrs/month.
 */
export const PROVIDER_C: CapacityProviderConfig = {
  name: 'ForgeProviderC',
  instanceTypes: ['g5.xlarge', 'g4dn.xlarge'],
  spot: true,
  minCapacity: 0,
  maxCapacity: 1,
  targetCapacityPercent: 100,
  architecture: 'x86_64',
  amiType: 'amazon-linux2', // GPU instances need Amazon Linux 2 with GPU drivers
  description: 'GPU Spot for AI/ML training (Modulus, DeepXDE). Scale-to-zero.',
  estimatedSpotPricePerHour: 0.34,
  estimatedMonthlyMin: 0,
  estimatedMonthlyMax: 245,
};

export const ALL_PROVIDERS: CapacityProviderConfig[] = [PROVIDER_A, PROVIDER_B, PROVIDER_C];

/** Capacity provider strategy for always-on services (Provider A only) */
export const PROVIDER_A_STRATEGY = [
  { capacityProviderName: PROVIDER_A.name, weight: 1, base: 1 },
];

/** Capacity provider strategy for scale-to-zero compute (Provider B) */
export const PROVIDER_B_STRATEGY = [
  { capacityProviderName: PROVIDER_B.name, weight: 1, base: 0 },
];

/** Capacity provider strategy for GPU workloads (Provider C) */
export const PROVIDER_C_STRATEGY = [
  { capacityProviderName: PROVIDER_C.name, weight: 1, base: 0 },
];
