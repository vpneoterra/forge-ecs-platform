/**
 * FORGE Geometry Platform Manifest
 *
 * Six geometry capabilities mapped to ECS task definitions and feature flags.
 * Follows the same double-gate architecture as the existing solver manifest:
 *   Gate 1: ECS service desiredCount (0 = dormant, 1 = running)
 *   Gate 2: Feature flag env var (false = routing disabled even if container is up)
 *
 * Activation state per capability:
 *   Cap 1 (B-Rep / STEP):       READY TO ACTIVATE  — CPU-only Fargate, lowest cost
 *   Cap 2 (GPU SDF):            DORMANT (ready but not activated) — requires GPU infra
 *   Cap 3 (Neural SDF):         DORMANT (ready but not activated) — requires GPU + trained model
 *   Cap 4 (Visual ASG Editor):  READY TO ACTIVATE  — client-side only, zero cost
 *   Cap 5 (Field-Driven TPMS):  READY TO ACTIVATE  — uses existing FluxTK, zero new cost
 *   Cap 6 (FluxTK / BRAIDE):    READY TO ACTIVATE  — CPU-only Fargate, conservation solver
 */

export interface GeometryCapability {
  /** Unique capability identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Feature flag env var name (injected into forge-app) */
  featureFlag: string;
  /** Default flag value at deploy time */
  defaultFlagValue: string;
  /** Whether this capability requires an ECS container */
  requiresContainer: boolean;
  /** Whether this capability requires GPU */
  requiresGpu: boolean;
  /** ECS task name (null for client-side-only capabilities) */
  taskName?: string;
  /** ECR repository name */
  ecrRepo?: string;
  /** Container port */
  port?: number;
  /** Health check path */
  healthCheckPath?: string;
  /** CPU units (256 increments) */
  cpu?: number;
  /** Memory in MB */
  memory?: number;
  /** Whether the ECS service starts with desiredCount=1 or 0 */
  activateOnDeploy: boolean;
  /** Endpoint env var name (injected into forge-app) */
  endpointEnvVar?: string;
  /** Default endpoint URL template (Cloud Map DNS) */
  defaultEndpoint?: string;
  /** Additional env vars for forge-app */
  appEnvVars: Record<string, string>;
  /** Container-specific env vars */
  containerEnvVars: Record<string, string>;
  /** Cost description */
  costDescription: string;
  /** What this capability enables */
  description: string;
  /** EFS source path for the container */
  efsSourcePath?: string;
  /** EFS container path */
  efsContainerPath?: string;
  /** Cloud Map DNS name */
  cloudMapName?: string;
  /** Activation phase (recommended order) */
  phase: number;
}

// ─── Capability 1: B-Rep / STEP Engine ──────────────────────────────────────
export const CAP_BREP: GeometryCapability = {
  id: 'brep',
  name: 'B-Rep / STEP Engine',
  featureFlag: 'BREP_ENGINE_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: true,
  requiresGpu: false,
  taskName: 'forge-brep',
  ecrRepo: 'forge-brep',
  port: 5090,
  healthCheckPath: '/api/brep/health',
  cpu: 2048,     // 2 vCPU
  memory: 4096,  // 4 GB — OpenCASCADE needs headroom
  activateOnDeploy: false,  // Ready but not activated — operator flips flag
  endpointEnvVar: 'BREP_ENDPOINT',
  defaultEndpoint: 'http://forge-brep.forge.local:5090',
  appEnvVars: {
    BREP_ENGINE_ENABLED: 'false',
    BREP_ENDPOINT: 'http://forge-brep.forge.local:5090',
  },
  containerEnvVars: {
    SERVICE_MODE: 'brep',
    LOG_LEVEL: 'INFO',
    OCCT_NUM_THREADS: '2',
    CADQUERY_WORKERS: '2',
    STEP_AP242_ENABLED: 'true',
  },
  costDescription: '~$0.10/hr active (Fargate 2vCPU/4GB), ~$10/month always-on',
  description: 'Full STEP AP242 import/export via OpenCASCADE. Bidirectional B-Rep ↔ SDF. CadQuery parametric scripting.',
  efsSourcePath: '/geometry',
  efsContainerPath: '/forge/workspace',
  cloudMapName: 'forge-brep',
  phase: 1,
};

// ─── Capability 2: GPU SDF Engine ───────────────────────────────────────────
export const CAP_GPU_SDF: GeometryCapability = {
  id: 'gpu-sdf',
  name: 'GPU SDF Engine',
  featureFlag: 'GPU_SDF_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: true,
  requiresGpu: true,
  taskName: 'forge-sdf-gpu',
  ecrRepo: 'forge-sdf-gpu',
  port: 5080,
  healthCheckPath: '/api/sdf/health',
  cpu: 4096,      // 4 vCPU
  memory: 15360,  // 15 GB — leaves headroom on g5.xlarge (16 GB)
  activateOnDeploy: false,  // DORMANT — not pulling the trigger
  endpointEnvVar: 'GPU_SDF_ENDPOINT',
  defaultEndpoint: 'http://forge-sdf-gpu.forge.local:5080',
  appEnvVars: {
    GPU_SDF_ENABLED: 'false',
    GPU_SDF_ENDPOINT: 'http://forge-sdf-gpu.forge.local:5080',
    GPU_SDF_VOXEL_THRESHOLD: '1000000',
  },
  containerEnvVars: {
    SERVICE_MODE: 'sdf-gpu',
    LOG_LEVEL: 'INFO',
    NVIDIA_VISIBLE_DEVICES: 'all',
    NVIDIA_DRIVER_CAPABILITIES: 'compute,utility',
  },
  costDescription: '~$0.30/hr Spot (g5.xlarge A10G), ~$1.01/hr on-demand. $0 when dormant.',
  description: 'GPU-accelerated SDF evaluation via libfive + NanoVDB. Replaces PicoGK for large parts above voxel threshold.',
  efsSourcePath: '/geometry',
  efsContainerPath: '/forge/workspace',
  cloudMapName: 'forge-sdf-gpu',
  phase: 4,
};

// ─── Capability 3: Neural SDF Engine ────────────────────────────────────────
export const CAP_NEURAL_SDF: GeometryCapability = {
  id: 'neural-sdf',
  name: 'Neural SDF Engine',
  featureFlag: 'NEURAL_SDF_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: true,
  requiresGpu: true,
  taskName: 'forge-neural-sdf',
  ecrRepo: 'forge-neural-sdf',
  port: 5100,
  healthCheckPath: '/api/neural/health',
  cpu: 4096,
  memory: 15360,
  activateOnDeploy: false,  // DORMANT — not pulling the trigger
  endpointEnvVar: 'NEURAL_SDF_ENDPOINT',
  defaultEndpoint: 'http://forge-neural-sdf.forge.local:5100',
  appEnvVars: {
    NEURAL_SDF_ENABLED: 'false',
    NEURAL_SDF_ENDPOINT: 'http://forge-neural-sdf.forge.local:5100',
  },
  containerEnvVars: {
    SERVICE_MODE: 'neural-sdf',
    LOG_LEVEL: 'INFO',
    NVIDIA_VISIBLE_DEVICES: 'all',
    NVIDIA_DRIVER_CAPABILITIES: 'compute,utility',
    DEEPSDF_LATENT_DIM: '256',
  },
  costDescription: 'Shares GPU with forge-sdf-gpu (~$0.30/hr Spot). Requires trained model weights.',
  description: 'DeepSDF auto-decoder for shape encoding. Latent-space interpolation, point cloud→mesh. Darwin evolutionary optimization.',
  efsSourcePath: '/geometry',
  efsContainerPath: '/forge/workspace',
  cloudMapName: 'forge-neural-sdf',
  phase: 5,
};

// ─── Capability 4: Visual ASG Editor ────────────────────────────────────────
export const CAP_ASG_EDITOR: GeometryCapability = {
  id: 'asg-editor',
  name: 'Visual ASG Editor',
  featureFlag: 'ASG_EDITOR_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: false,
  requiresGpu: false,
  activateOnDeploy: false,  // Ready — operator flips flag
  appEnvVars: {
    ASG_EDITOR_ENABLED: 'false',
  },
  containerEnvVars: {},
  costDescription: '$0. Client-side JavaScript only.',
  description: 'Visual node-graph programming for SDF geometry in axiom-studio.html. 30 node types mapping to libfive opcodes.',
  phase: 3,
};

// ─── Capability 5: Field-Driven TPMS ────────────────────────────────────────
export const CAP_FIELD_TPMS: GeometryCapability = {
  id: 'field-tpms',
  name: 'Field-Driven TPMS',
  featureFlag: 'FIELD_DRIVEN_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: false,
  requiresGpu: false,
  activateOnDeploy: false,  // Ready — operator flips flag
  appEnvVars: {
    FIELD_DRIVEN_ENABLED: 'false',
    FIELD_DRIVEN_MIN_THICKNESS_MM: '0.3',
    FIELD_DRIVEN_MAX_THICKNESS_MM: '5.0',
  },
  containerEnvVars: {},
  costDescription: '$0 incremental. Uses existing FluxTK + PicoGK (or GPU SDF if enabled).',
  description: 'TPMS lattice wall thickness modulated by FluxTK simulation fields (stress, temperature, flow velocity).',
  phase: 2,
};

// ─── Capability 6: FluxTK / BRAIDE Network Solver ───────────────────────────
export const CAP_FLUXTK: GeometryCapability = {
  id: 'fluxtk',
  name: 'FluxTK / BRAIDE Network Solver',
  featureFlag: 'FLUXTK_ENABLED',
  defaultFlagValue: 'false',
  requiresContainer: true,
  requiresGpu: false,
  taskName: 'forge-fluxtk',
  ecrRepo: 'forge-fluxtk',
  port: 8040,
  healthCheckPath: '/health',
  cpu: 1024,     // 1 vCPU — sparse Cholesky/LU solves are memory-bound, not CPU-bound
  memory: 2048,  // 2 GB — handles 2000-node networks with headroom for CHOLMOD factorization
  activateOnDeploy: false,  // DORMANT — operator flips flag after image is pushed
  endpointEnvVar: 'FLUXTK_API_URL',
  defaultEndpoint: 'http://forge-fluxtk.forge-geometry.local:8040',
  appEnvVars: {
    FLUXTK_ENABLED: 'false',
    FLUXTK_API_URL: 'http://forge-fluxtk.forge-geometry.local:8040',
  },
  containerEnvVars: {
    SERVICE_MODE: 'fluxtk',
    LOG_LEVEL: 'INFO',
    FORGE_PORT: '8040',
    FORGE_TIMEOUT: '300',
    FLUXTK_MAX_NODES: '2000',
    FLUXTK_CONVERGENCE_TOL: '1e-10',
    FLUXTK_MAX_COUPLING_ITERATIONS: '20',
  },
  costDescription: '~$0.05/hr active (Fargate 1vCPU/2GB), ~$5/month always-on. $0 when dormant.',
  description: 'Conservation network solver (thermal, electrical, fluid, diffusion, mechanical). Sparse Cholesky on conductance matrices. Multi-physics coupling via iterative cascade. Sub-1ms for 200-node assemblies. CLASP topology optimization.',
  efsSourcePath: '/geometry',
  efsContainerPath: '/forge/workspace',
  cloudMapName: 'forge-fluxtk',
  phase: 2,  // Same phase as Field-Driven TPMS — FluxTK is a dependency for Cap 5
};

// ─── Aggregates ─────────────────────────────────────────────────────────────

/** All six geometry capabilities */
export const GEOMETRY_CAPABILITIES: GeometryCapability[] = [
  CAP_BREP,
  CAP_GPU_SDF,
  CAP_NEURAL_SDF,
  CAP_ASG_EDITOR,
  CAP_FIELD_TPMS,
  CAP_FLUXTK,
];

/** Capabilities that require an ECS container */
export const CONTAINER_CAPABILITIES = GEOMETRY_CAPABILITIES.filter(c => c.requiresContainer);

/** Capabilities that require GPU */
export const GPU_CAPABILITIES = GEOMETRY_CAPABILITIES.filter(c => c.requiresGpu);

/** CPU-only container capabilities */
export const CPU_CAPABILITIES = CONTAINER_CAPABILITIES.filter(c => !c.requiresGpu);

/** Client-side-only capabilities (no container) */
export const CLIENT_CAPABILITIES = GEOMETRY_CAPABILITIES.filter(c => !c.requiresContainer);

/**
 * All feature flag env vars to inject into forge-app.
 * Merges appEnvVars from all capabilities into a single record.
 */
export function getAllGeometryAppEnvVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const cap of GEOMETRY_CAPABILITIES) {
    Object.assign(vars, cap.appEnvVars);
  }
  return vars;
}

/** Lookup a capability by ID */
export function getCapability(id: string): GeometryCapability {
  const cap = GEOMETRY_CAPABILITIES.find(c => c.id === id);
  if (!cap) throw new Error(`Geometry capability '${id}' not found`);
  return cap;
}
