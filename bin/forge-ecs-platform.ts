#!/usr/bin/env node
/**
 * FORGE ECS Platform — CDK App Entry Point
 *
 * Creates 4 stacks in dependency order:
 *   1. ForgeNetworkStack   — VPC, NAT instance, security groups
 *   2. ForgeDataStack      — S3, EFS, RDS, ECR, DynamoDB
 *   3. ForgeComputeStack   — ECS cluster, capacity providers, tasks, services
 *   4. ForgeOrchestrationStack — Step Functions, EventBridge, CloudWatch
 *
 * Context variables (pass via -c key=value or cdk.json):
 *   env         "dev" (default) | "prod"
 *   account     AWS account ID (default: CDK_DEFAULT_ACCOUNT)
 *   region      AWS region     (default: CDK_DEFAULT_REGION or us-east-1)
 *   alertEmail  Email for CloudWatch SNS alerts (default: ops@forge.local)
 *   skipRds     "true" to skip RDS and use external Supabase (default: "false")
 *
 * Usage:
 *   npx cdk deploy --all -c env=dev
 *   npx cdk deploy --all -c env=prod -c alertEmail=you@example.com
 *   npx cdk deploy --all -c env=dev -c skipRds=true
 */

import * as cdk from 'aws-cdk-lib';
import { ForgeNetworkStack } from '../lib/forge-network-stack';
import { ForgeDataStack } from '../lib/forge-data-stack';
import { ForgeComputeStack } from '../lib/forge-compute-stack';
import { ForgeOrchestrationStack } from '../lib/forge-orchestration-stack';

const app = new cdk.App();

// ── Resolve context ──────────────────────────────────────────────────────────
const env = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const alertEmail =
  (app.node.tryGetContext('alertEmail') as string | undefined) ?? 'ops@forge.local';
const skipRds =
  (app.node.tryGetContext('skipRds') as string | undefined) === 'true';

const awsEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
};

// ── Shared tags applied to all resources ─────────────────────────────────────
const sharedTags: Record<string, string> = {
  Project: 'FORGE',
  Environment: env,
  ManagedBy: 'CDK',
  CostCenter: 'forge-platform',
  Owner: 'vpneoterra',
};

// ── Stack 1: Network ─────────────────────────────────────────────────────────
const networkStack = new ForgeNetworkStack(app, `ForgeNetwork-${env}`, {
  env: awsEnv,
  description: 'FORGE VPC, NAT Instance, Security Groups',
  forgeEnv: env,
  tags: sharedTags,
});

// ── Stack 2: Data ─────────────────────────────────────────────────────────────
const dataStack = new ForgeDataStack(app, `ForgeData-${env}`, {
  env: awsEnv,
  description: 'FORGE S3, EFS, RDS, ECR repositories, DynamoDB',
  forgeEnv: env,
  vpc: networkStack.vpc,
  dbSecurityGroup: networkStack.rdsSecurityGroup,
  efsSecurityGroup: networkStack.efsSecurityGroup,
  skipRds,
  tags: sharedTags,
});
dataStack.addDependency(networkStack);

// ── Stack 3: Compute ──────────────────────────────────────────────────────────
const computeStack = new ForgeComputeStack(app, `ForgeCompute-${env}`, {
  env: awsEnv,
  description: 'FORGE ECS Cluster, Capacity Providers, Task Definitions, Services',
  forgeEnv: env,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  publicSubnets: networkStack.publicSubnets,
  ecsSecurityGroup: networkStack.ecsSecurityGroup,
  albSecurityGroup: networkStack.albSecurityGroup,
  dataBucket: dataStack.dataBucket,
  efsFilesystem: dataStack.efsFilesystem,
  jobsTable: dataStack.jobsTable,
  ecrRepos: dataStack.ecrRepos,
  rdsEndpoint: dataStack.rdsEndpoint,
  tags: sharedTags,
});
computeStack.addDependency(dataStack);

// ── Stack 4: Orchestration ────────────────────────────────────────────────────
const orchestrationStack = new ForgeOrchestrationStack(app, `ForgeOrchestration-${env}`, {
  env: awsEnv,
  description: 'FORGE Step Functions, EventBridge, CloudWatch Alarms',
  forgeEnv: env,
  ecsCluster: computeStack.ecsCluster,
  taskDefinitions: computeStack.taskDefinitions,
  sqsQueues: computeStack.sqsQueues,
  jobsTable: dataStack.jobsTable,
  alertEmail,
  tags: sharedTags,
});
orchestrationStack.addDependency(computeStack);

// Apply tags to all stacks
for (const [k, v] of Object.entries(sharedTags)) {
  cdk.Tags.of(app).add(k, v);
}

app.synth();
