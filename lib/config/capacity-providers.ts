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
 * Hosts: forge-lightweight + forge-devops + forge-monitoring (all fit on c6g.xlarge: 4 vCPU, 8 GB)
 * Total always-on CPU: 7 vCPU, ~12.8 GB. Fits on c6g.xlarge with ~10% headroom.
 * Spot price: ~$0.07/hr -> $51/month
 */
export const PROVIDER_A: CapacityProviderConfig = {
  name: 'ForgeProviderA',
  instanceTypes: ['c6g.xlarge', 'c6g.large', 'm6g.xlarge', 'm7g.xlarge'],
  spot: true,
  minCapacity: 1,
  maxCapacity: 2,
  targetCapacityPercent: 80,
  architecture: 'arm64',
  amiType: 'bottlerocket-arm64',
  description: 'Graviton Spot for always-on services (geometry, devops, monitoring)',
  estimatedSpotPricePerHour: 0.07,
  estimatedMonthlyMin: 51,
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
