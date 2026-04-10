#!/usr/bin/env node
/**
 * FORGE ECS Platform -- CDK App Entry Point
 *
 * Two deployment modes:
 *
 *   MODE 1: App-only (default when deployApp=true)
 *     ForgeNetworkStack -> ForgeAppStack (Fargate)
 *     Minimal cost (~$25/month), deploys the FORGE web app only.
 *
 *   MODE 2: Full platform (when deploySolvers=true)
 *     ForgeNetworkStack -> ForgeDataStack -> ForgeComputeStack -> ForgeOrchestrationStack
 *     Full solver infrastructure with EC2 capacity providers.
 *
 * Context variables:
 *   env           "dev" (default) | "prod"
 *   deployApp     "true" to deploy ForgeAppStack (Fargate web app)
 *   deployOmni    "true" to deploy ForgeOmniStack (OMNI PicoGK Fargate)
 *   deployDks     "true" to deploy DKS (Design Knowledge System) in ForgeAppStack
 *   deployGemma   "true" to deploy Gemma GPU inference stack (g6.2xlarge + NLB)
 *   deploySolvers "true" to deploy full Compute + Orchestration stacks
 *   skipRds       "true" to skip RDS (use external Supabase)
 *   appDomain     Domain for forge-app (default: forgetest.qrucible.ai)
 *   omniDomain    Domain for OMNI (default: omni.qrucible.ai)
 *   alertEmail    Email for CloudWatch alerts (default: ops@forge.local)
 *
 * Usage:
 *   npx cdk deploy --all -c env=dev -c deployApp=true -c appDomain=forgetest.qrucible.ai -c skipRds=true
 *   npx cdk deploy ForgeOmni-dev -c env=dev -c deployOmni=true -c omniDomain=omni.qrucible.ai
 *   npx cdk deploy --all -c env=dev -c deploySolvers=true -c alertEmail=you@example.com
 */

import * as cdk from 'aws-cdk-lib';
import { ForgeNetworkStack } from '../lib/forge-network-stack';
import { ForgeDataStack } from '../lib/forge-data-stack';
import { ForgeComputeStack } from '../lib/forge-compute-stack';
import { ForgeAppStack } from '../lib/forge-app-stack';
import { ForgeOmniStack } from '../lib/forge-omni-stack';
import { ForgeGemmaStack } from '../lib/forge-gemma-stack';
import { ForgeOrchestrationStack } from '../lib/forge-orchestration-stack';

const app = new cdk.App();

// -- Resolve context ---------------------------------------------------------
const env = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';
const alertEmail =
  (app.node.tryGetContext('alertEmail') as string | undefined) ?? 'ops@forge.local';
const skipRds =
  (app.node.tryGetContext('skipRds') as string | undefined) === 'true';
const deployApp =
  (app.node.tryGetContext('deployApp') as string | undefined) === 'true';
const deploySolvers =
  (app.node.tryGetContext('deploySolvers') as string | undefined) === 'true';
const appDomain =
  (app.node.tryGetContext('appDomain') as string | undefined) ?? 'forge.qrucible.ai';
const deployDks =
  (app.node.tryGetContext('deployDks') as string | undefined) === 'true';
const deployOmni =
  (app.node.tryGetContext('deployOmni') as string | undefined) === 'true';
const deployGemma =
  (app.node.tryGetContext('deployGemma') as string | undefined) === 'true';
const omniDomain =
  (app.node.tryGetContext('omniDomain') as string | undefined) ?? 'omni.qrucible.ai';

const awsEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
};

// -- Shared tags -------------------------------------------------------------
const sharedTags: Record<string, string> = {
  Project: 'FORGE',
  Environment: env,
  ManagedBy: 'CDK',
  CostCenter: 'forge-platform',
  Owner: 'vpneoterra',
};

// -- Stack 1: Network (always deployed) --------------------------------------
const networkStack = new ForgeNetworkStack(app, `ForgeNetwork-${env}`, {
  env: awsEnv,
  description: 'FORGE VPC, NAT Instance, Security Groups',
  forgeEnv: env,
  tags: sharedTags,
});

// -- MODE 1: App-only (Fargate) ----------------------------------------------
// -- Gemma GPU Stack (optional, self-hosted inference) -------------------------
let gemmaStack: ForgeGemmaStack | undefined;
if (deployGemma) {
  gemmaStack = new ForgeGemmaStack(app, `ForgeGemma-${env}`, {
    env: awsEnv,
    description: 'FORGE Gemma 4 GPU Inference -- g6.2xlarge, vLLM, internal NLB',
    forgeEnv: env,
    vpc: networkStack.vpc,
    ecsSecurityGroup: networkStack.ecsSecurityGroup,
    privateSubnets: networkStack.privateSubnets,
    publicSubnets: networkStack.publicSubnets,
    tags: sharedTags,
  });
  gemmaStack.addDependency(networkStack);
}

if (deployApp) {
  const appStack = new ForgeAppStack(app, `ForgeApp-${env}`, {
    env: awsEnv,
    description: 'FORGE Web App + OMNI -- Fargate, ALB, Route 53, ACM, Secrets',
    forgeEnv: env,
    vpc: networkStack.vpc,
    ecsSecurityGroup: networkStack.ecsSecurityGroup,
    albSecurityGroup: networkStack.albSecurityGroup,
    privateSubnets: networkStack.privateSubnets,
    publicSubnets: networkStack.publicSubnets,
    domainName: appDomain,
    omniDomainName: omniDomain,
    hostedZoneDomain: appDomain.split('.').slice(-2).join('.'), // e.g., 'qrucible.ai'
    deployDks,
    deployGemma,
    gemmaEndpoint: gemmaStack?.gemmaEndpoint,
    tags: sharedTags,
  });
  appStack.addDependency(networkStack);
  if (gemmaStack) {
    appStack.addDependency(gemmaStack);
  }
}

// -- OMNI PicoGK Fountain Pen Generator (Fargate) ----------------------------
if (deployOmni) {
  const omniStack = new ForgeOmniStack(app, `ForgeOmni-${env}`, {
    env: awsEnv,
    description: 'OMNI PicoGK Fountain Pen Generator -- Fargate, ALB, Route 53, ACM',
    forgeEnv: env,
    vpc: networkStack.vpc,
    ecsSecurityGroup: networkStack.ecsSecurityGroup,
    albSecurityGroup: networkStack.albSecurityGroup,
    privateSubnets: networkStack.privateSubnets,
    publicSubnets: networkStack.publicSubnets,
    domainName: omniDomain,
    hostedZoneDomain: omniDomain.split('.').slice(-2).join('.'),
    tags: sharedTags,
  });
  omniStack.addDependency(networkStack);
}

// -- Preserve cross-stack exports if legacy stacks (Data/Compute) still exist.
// ForgeData-dev imports these auto-generated exports from ForgeNetwork-dev.
// If we don't synthesize ForgeData-dev, CDK removes the exports and CloudFormation
// blocks the update.  We preserve the exact export names with explicit CfnOutputs.
if (!deploySolvers) {
  // The auto-generated export for EfsSg GroupId -- exact logical ID from CDK
  new cdk.CfnOutput(networkStack, 'ExportsOutputFnGetAttEfsSgCAB16DA1GroupId4DE98B00', {
    value: networkStack.efsSecurityGroup.securityGroupId,
    exportName: `ForgeNetwork-${env}:ExportsOutputFnGetAttEfsSgCAB16DA1GroupId4DE98B00`,
  });
  // The auto-generated export for RdsSg GroupId
  new cdk.CfnOutput(networkStack, 'ExportsOutputFnGetAttRdsSg4BD60B44GroupIdBF9D78FB', {
    value: networkStack.rdsSecurityGroup.securityGroupId,
    exportName: `ForgeNetwork-${env}:ExportsOutputFnGetAttRdsSg4BD60B44GroupIdBF9D78FB`,
  });
}

// -- MODE 2: Full solver platform (EC2 compute) ------------------------------
if (deploySolvers) {
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
}

// Apply tags to all stacks
for (const [k, v] of Object.entries(sharedTags)) {
  cdk.Tags.of(app).add(k, v);
}

app.synth();
