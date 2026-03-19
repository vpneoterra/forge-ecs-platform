/**
 * FORGE Solver Manifest
 * Defines all 8 consolidated ECS tasks with cost-optimized resource allocations.
 * 30+ services condensed into 8 tasks, targeting $72-$116/month for 1-2 person team.
 */

export type ScalingMode = 'always-on' | 'sqs-driven' | 'schedule';
export type Provider = 'A' | 'B' | 'C';

export interface VolumeMount {
  /** 'efs' or 's3' */
  type: 'efs' | 's3';
  /** Container path */
  containerPath: string;
  /** EFS Access Point path or S3 prefix */
  sourcePath: string;
  readOnly?: boolean;
}

export interface SolverTask {
  /** Logical name used for ECS service / task def */
  name: string;
  /** ECR repository name */
  imageRepo: string;
  /** 256-unit increments (1 vCPU = 1024) */
  cpu: number;
  /** MB */
  memory: number;
  /** Primary HTTP port exposed by the container */
  port: number;
  /** Which capacity provider hosts this task */
  provider: Provider;
  /** Health check path (relative) */
  healthCheckPath: string;
  /** Whether the container is essential in its task definition */
  essential: boolean;
  /** How the task is launched */
  scalingMode: ScalingMode;
  /** Human description of what this task consolidates */
  description: string;
  /** SQS FIFO queue name — required when scalingMode = 'sqs-driven' */
  sqsQueueName?: string;
  /** Environment variables injected at runtime (values resolved from SSM/Secrets Manager at deploy) */
  environment: Record<string, string>;
  /** EFS/S3 volume mounts */
  volumes: VolumeMount[];
  /** Services consolidated into this container */
  consolidatedServices: string[];
}

export const SOLVER_MANIFEST: SolverTask[] = [
  // ─────────────────────────────────────────────────────────────
  // PROVIDER A — Graviton Spot, c6g.xlarge, always-on
  // ─────────────────────────────────────────────────────────────
  {
    name: 'forge-lightweight',
    imageRepo: 'forge-cluster-a-geometry',
    cpu: 2048,   // 2 vCPU
    memory: 3840, // ~3.75 GB
    port: 8080,
    provider: 'A',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'always-on',
    description: 'All Cluster A geometry services + stellarator orchestrator',
    environment: {
      SERVICE_MODE: 'geometry',
      LOG_LEVEL: 'INFO',
      CADQUERY_WORKERS: '2',
      PARAMAK_WORKERS: '1',
      PICOGK_WORKERS: '1',
      STELLARATOR_ORCHESTRATOR: 'true',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/geometry' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'geometry/' },
    ],
    consolidatedServices: [
      'CadQuery',
      'Paramak',
      'ParaStell',
      'PicoGK',
      'Stellarator Orchestrator',
    ],
  },
  {
    name: 'forge-devops',
    imageRepo: 'forge-cluster-f-devops',
    cpu: 4096,   // 4 vCPU
    memory: 7168, // 7 GB
    port: 80,
    provider: 'A',
    healthCheckPath: '/healthz',
    essential: true,
    scalingMode: 'always-on',
    description: 'Cluster F (Nginx, forge-app, Forgejo, MinIO) + Cluster E (SysML API + SysON)',
    environment: {
      SERVICE_MODE: 'devops',
      LOG_LEVEL: 'INFO',
      NGINX_WORKERS: 'auto',
      FORGEJO_DOMAIN: 'git.forge.local',
      MINIO_ROOT_USER_SECRET: 'forge/minio/root',
      SYSML_API_PORT: '9000',
      SYSONS_PORT: '9001',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
      // DB_HOST resolved at runtime via Cloud Map / SSM
      POSTGRES_DB: 'forge_devops',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/repos', sourcePath: '/forgejo' },
      { type: 'efs', containerPath: '/forge/minio', sourcePath: '/minio' },
      { type: 's3', containerPath: '/forge/artifacts', sourcePath: 'artifacts/' },
    ],
    consolidatedServices: [
      'Nginx',
      'forge-app',
      'Forgejo',
      'MinIO',
      'SysML API',
      'SysON',
    ],
  },
  {
    name: 'forge-monitoring',
    imageRepo: 'forge-cluster-c-observability',
    cpu: 1024,   // 1 vCPU
    memory: 1792, // 1.75 GB
    port: 3000,
    provider: 'A',
    healthCheckPath: '/api/health',
    essential: true,
    scalingMode: 'always-on',
    description: 'Cluster C: Prometheus + Grafana + Alertmanager via supervisord, with Node Exporter and cAdvisor sidecars',
    environment: {
      SERVICE_MODE: 'monitoring',
      GF_SECURITY_ADMIN_PASSWORD_SECRET: 'forge/grafana/admin',
      PROMETHEUS_RETENTION: '7d',
      PROMETHEUS_STORAGE_PATH: '/prometheus',
      ALERTMANAGER_CONFIG: '/etc/alertmanager/config.yml',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/prometheus', sourcePath: '/prometheus' },
      { type: 'efs', containerPath: '/grafana', sourcePath: '/grafana' },
    ],
    consolidatedServices: [
      'Prometheus',
      'Grafana',
      'Alertmanager',
      'Node Exporter',
      'cAdvisor',
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // PROVIDER A — SQS-driven scale-to-zero
  // ─────────────────────────────────────────────────────────────
  {
    name: 'forge-stellarator-config',
    imageRepo: 'forge-stellarator-config',
    cpu: 4096,   // 4 vCPU
    memory: 4096, // 4 GB
    port: 8090,
    provider: 'A',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'sqs-driven',
    sqsQueueName: 'forge-stellarator-config.fifo',
    description: 'Stellarator configuration solver: DESC, pyQSC, pyQIC. Scale 0→1 on SQS message.',
    environment: {
      SERVICE_MODE: 'stellarator-config',
      LOG_LEVEL: 'INFO',
      SQS_QUEUE_NAME: 'forge-stellarator-config.fifo',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
      DESC_WORKERS: '4',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/stellarator-config' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'stellarator-config/' },
    ],
    consolidatedServices: ['DESC', 'pyQSC', 'pyQIC'],
  },

  // ─────────────────────────────────────────────────────────────
  // PROVIDER B — x86 Spot, scale-to-zero heavy compute
  // ─────────────────────────────────────────────────────────────
  {
    name: 'forge-hpc',
    imageRepo: 'forge-cluster-b-hpc',
    cpu: 8192,    // 8 vCPU
    memory: 16384, // 16 GB
    port: 8100,
    provider: 'B',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'sqs-driven',
    sqsQueueName: 'forge-hpc.fifo',
    description: 'Cluster B HPC: PROCESS, VMEC++, OpenMC. Scale 0→N on SQS message.',
    environment: {
      SERVICE_MODE: 'hpc',
      LOG_LEVEL: 'INFO',
      SQS_QUEUE_NAME: 'forge-hpc.fifo',
      OMP_NUM_THREADS: '8',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/hpc' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'hpc/' },
    ],
    consolidatedServices: ['PROCESS', 'VMEC++', 'OpenMC'],
  },
  {
    name: 'forge-fem-cfd',
    imageRepo: 'forge-cluster-d-fem',
    cpu: 16384,   // 16 vCPU
    memory: 32768, // 32 GB
    port: 8200,
    provider: 'B',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'sqs-driven',
    sqsQueueName: 'forge-fem-cfd.fifo',
    description: 'Cluster D FEM/CFD: Elmer, CalculiX, OpenFOAM, Gmsh. Largest instance for parallel solvers.',
    environment: {
      SERVICE_MODE: 'fem-cfd',
      LOG_LEVEL: 'INFO',
      SQS_QUEUE_NAME: 'forge-fem-cfd.fifo',
      OMP_NUM_THREADS: '16',
      OPENFOAM_PARALLEL: 'true',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/fem-cfd' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'fem-cfd/' },
    ],
    consolidatedServices: ['Elmer', 'CalculiX', 'OpenFOAM', 'Gmsh'],
  },
  {
    name: 'forge-stellarator-coils',
    imageRepo: 'forge-stellarator-coils',
    cpu: 6144,   // 6 vCPU
    memory: 8192, // 8 GB
    port: 8300,
    provider: 'B',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'sqs-driven',
    sqsQueueName: 'forge-stellarator-coils.fifo',
    description: 'Stellarator coil optimization: SIMSOPT, VMEC++, BOOZ_XFORM',
    environment: {
      SERVICE_MODE: 'stellarator-coils',
      LOG_LEVEL: 'INFO',
      SQS_QUEUE_NAME: 'forge-stellarator-coils.fifo',
      OMP_NUM_THREADS: '6',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/stellarator-coils' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'stellarator-coils/' },
    ],
    consolidatedServices: ['SIMSOPT', 'VMEC++', 'BOOZ_XFORM'],
  },
  {
    name: 'forge-stellarator-cad',
    imageRepo: 'forge-stellarator-cad',
    cpu: 4096,   // 4 vCPU
    memory: 4096, // 4 GB
    port: 8400,
    provider: 'B',
    healthCheckPath: '/health',
    essential: true,
    scalingMode: 'sqs-driven',
    sqsQueueName: 'forge-stellarator-cad.fifo',
    description: 'Stellarator CAD generation: Bluemira, ParaStell, Paramak',
    environment: {
      SERVICE_MODE: 'stellarator-cad',
      LOG_LEVEL: 'INFO',
      SQS_QUEUE_NAME: 'forge-stellarator-cad.fifo',
      DYNAMODB_TABLE: 'forge-jobs',
      S3_BUCKET: 'forge-platform-data',
    },
    volumes: [
      { type: 'efs', containerPath: '/forge/workspace', sourcePath: '/stellarator-cad' },
      { type: 's3', containerPath: '/forge/outputs', sourcePath: 'stellarator-cad/' },
    ],
    consolidatedServices: ['Bluemira', 'ParaStell', 'Paramak'],
  },
];

/** Tasks that run always-on on Provider A */
export const ALWAYS_ON_TASKS = SOLVER_MANIFEST.filter(t => t.scalingMode === 'always-on');

/** Tasks driven by SQS messages (scale to zero when idle) */
export const SQS_DRIVEN_TASKS = SOLVER_MANIFEST.filter(t => t.scalingMode === 'sqs-driven');

/** SQS queue names for all scale-to-zero tasks */
export const SQS_QUEUE_NAMES: string[] = SQS_DRIVEN_TASKS
  .map(t => t.sqsQueueName)
  .filter((q): q is string => q !== undefined);

/** Lookup a task by name */
export function getTask(name: string): SolverTask {
  const task = SOLVER_MANIFEST.find(t => t.name === name);
  if (!task) throw new Error(`Task '${name}' not found in SOLVER_MANIFEST`);
  return task;
}
