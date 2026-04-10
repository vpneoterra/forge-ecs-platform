/**
 * ForgeGemmaStack -- Self-Hosted Gemma 4 Inference (GPU)
 *
 * Deploys a single g6.2xlarge GPU instance running vLLM with Gemma 4 26B MoE,
 * fronted by an internal NLB for private VPC access from ECS tasks.
 *
 * Architecture:
 *   ECS forge-app → NLB (gemma-internal:8000) → GPU EC2 instance (vLLM)
 *
 * The instance runs in a private subnet with no public IP.
 * Access is via SSM Session Manager (no SSH key needed).
 * vLLM serves an OpenAI-compatible API on port 8000.
 *
 * Cost breakdown (us-east-1):
 *   - g6.2xlarge On-Demand: ~$0.978/hr ($714/month always-on)
 *   - g6.2xlarge scheduled (10hrs/day weekdays): ~$215/month
 *   - NLB: ~$16/month + $0.006/LCU-hour
 *   - EBS gp3 100GB: ~$8/month
 *   Total: ~$239–$738/month depending on schedule
 *
 * When the GPU instance is stopped, the Gemma circuit breaker in forge-app
 * opens automatically and all calls fall back to Claude.
 *
 * References:
 *   - FORGE_Gemma4_Developer_Runbook-2.docx (Steps 3-8)
 *   - .forge/config/model-routing.json
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ForgeGemmaStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  /** HuggingFace token ARN in Secrets Manager (for gated model download) */
  hfTokenSecretArn?: string;
  tags?: Record<string, string>;
}

export class ForgeGemmaStack extends cdk.Stack {
  public readonly nlbDnsName: string;
  public readonly gemmaEndpoint: string;
  public readonly gemmaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ForgeGemmaStackProps) {
    super(scope, id, props);

    const isProd = props.forgeEnv === 'prod';

    // ── Security Group: Gemma GPU Instance ─────────────────────────────────
    this.gemmaSecurityGroup = new ec2.SecurityGroup(this, 'GemmaSg', {
      vpc: props.vpc,
      description: 'Gemma GPU instance -- vLLM inference endpoint',
      allowAllOutbound: true,
    });

    // Allow vLLM port (8000) from ECS tasks only
    this.gemmaSecurityGroup.addIngressRule(
      props.ecsSecurityGroup,
      ec2.Port.tcp(8000),
      'vLLM inference from ECS tasks',
    );

    // Allow health checks from NLB (NLB lives in same VPC)
    this.gemmaSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(8000),
      'NLB health checks + vLLM access from VPC',
    );

    // Allow SSM for management (no SSH needed)
    // SSM uses outbound HTTPS — no inbound rule needed

    // ── IAM Role for GPU Instance ──────────────────────────────────────────
    const gpuRole = new iam.Role(this, 'GemmaGpuRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
      description: 'Gemma GPU instance -- SSM access + Secrets Manager for HF token',
    });

    // Allow reading HuggingFace token from Secrets Manager
    gpuRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        props.hfTokenSecretArn
          || `arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/gemma/*`,
      ],
    }));

    // CloudWatch Logs for vLLM
    const logGroup = new logs.LogGroup(this, 'GemmaLogGroup', {
      logGroupName: '/forge/gemma/vllm',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    gpuRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
    }));

    // ── GPU Instance (g6.2xlarge -- 1x L4, 8 vCPUs, 32 GB RAM) ────────────
    // Uses Amazon Linux 2023 with NVIDIA GPU AMI
    const gpuAmi = ec2.MachineImage.lookup({
      name: 'Deep Learning AMI GPU PyTorch * (Amazon Linux 2023) *',
      owners: ['amazon'],
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Log to CloudWatch',
      'exec > >(tee /var/log/gemma-setup.log) 2>&1',
      '',
      '# Wait for NVIDIA drivers',
      'echo "Waiting for NVIDIA drivers..."',
      'for i in $(seq 1 30); do nvidia-smi && break || sleep 10; done',
      '',
      '# Install vLLM',
      'pip3 install vllm --quiet',
      '',
      '# Retrieve HuggingFace token from Secrets Manager',
      `HF_TOKEN=$(aws secretsmanager get-secret-value --secret-id forge/gemma/hf-token --region ${this.region} --query SecretString --output text 2>/dev/null || echo "")`,
      '',
      '# Download and serve model',
      'echo "Starting vLLM server..."',
      'nohup python3 -m vllm.entrypoints.openai.api_server \\',
      '  --model google/gemma-4-26b-a4b-it-gptq-4bit \\',
      '  --host 0.0.0.0 \\',
      '  --port 8000 \\',
      '  --max-model-len 32768 \\',
      '  --gpu-memory-utilization 0.92 \\',
      '  --dtype auto \\',
      '  --quantization gptq \\',
      '  --enforce-eager \\',
      '  --trust-remote-code \\',
      '  > /var/log/vllm.log 2>&1 &',
      '',
      'echo "vLLM server starting on port 8000"',
    );

    const gpuInstance = new ec2.Instance(this, 'GemmaGpuInstance', {
      vpc: props.vpc,
      instanceType: new ec2.InstanceType('g6.2xlarge'),
      machineImage: gpuAmi,
      role: gpuRole,
      securityGroup: this.gemmaSecurityGroup,
      vpcSubnets: { subnets: props.privateSubnets },
      userData,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(100, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          iops: 3000,
          throughput: 250,
        }),
      }],
      requireImdsv2: true,
      detailedMonitoring: false,
      propagateTagsToVolumeOnCreation: true,
    });

    // Tag for identification and cost tracking
    cdk.Tags.of(gpuInstance).add('Name', `forge-gemma-gpu-${props.forgeEnv}`);
    cdk.Tags.of(gpuInstance).add('Component', 'gemma-inference');

    // ── Internal NLB (no internet exposure) ────────────────────────────────
    const nlb = new elbv2.NetworkLoadBalancer(this, 'GemmaNlb', {
      loadBalancerName: `gemma-nlb-${props.forgeEnv}`,
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnets: props.privateSubnets },
      crossZoneEnabled: true,
    });

    const targetGroup = new elbv2.NetworkTargetGroup(this, 'GemmaTargetGroup', {
      vpc: props.vpc,
      port: 8000,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        path: '/health',
        port: '8000',
        interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    targetGroup.addTarget(new targets.InstanceTarget(gpuInstance, 8000));

    nlb.addListener('GemmaListener', {
      port: 8000,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [targetGroup],
    });

    // Store for cross-stack references
    this.nlbDnsName = nlb.loadBalancerDnsName;
    this.gemmaEndpoint = `http://${nlb.loadBalancerDnsName}:8000/v1`;

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'GemmaNlbDns', {
      value: nlb.loadBalancerDnsName,
      description: 'Gemma NLB DNS name (internal, use as GEMMA_ENDPOINT host)',
      exportName: `ForgeGemmaNlbDns-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'GemmaEndpoint', {
      value: this.gemmaEndpoint,
      description: 'Full Gemma vLLM endpoint URL for task definition env vars',
      exportName: `ForgeGemmaEndpoint-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'GemmaInstanceId', {
      value: gpuInstance.instanceId,
      description: 'GPU instance ID -- use to stop/start for cost savings',
      exportName: `ForgeGemmaInstanceId-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'GemmaSecurityGroupId', {
      value: this.gemmaSecurityGroup.securityGroupId,
      description: 'Gemma security group ID',
    });

    new cdk.CfnOutput(this, 'GemmaLogGroup', {
      value: logGroup.logGroupName,
      description: 'CloudWatch log group for vLLM logs',
    });

    new cdk.CfnOutput(this, 'GemmaCostNote', {
      value: 'g6.2xlarge: $0.978/hr on-demand. Stop instance when not in use. Circuit breaker auto-routes to Claude.',
      description: 'Cost optimization reminder',
    });
  }
}
