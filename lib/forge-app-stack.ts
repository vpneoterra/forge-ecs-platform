/**
 * ForgeAppStack — FORGE Web Application (test branch)
 *
 * Deploys the forge-app (Node.js Express) as an ECS service behind an ALB.
 * Uses the existing ECS cluster from ForgeComputeStack.
 * ALB handles TLS termination via ACM certificate for forgetest.qrucible.ai.
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed) + $0.008/LCU-hour
 *   - ACM: free
 *   - ECS task: runs on existing Provider A Graviton Spot (no additional EC2)
 *   - Secrets Manager: $0.40/secret/month × 5 = $2/month
 *   - CloudWatch Logs: ~$0.50/month (7-day retention)
 *   Total incremental: ~$19/month
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ForgeAppStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsCluster: ecs.Cluster;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'forgetest.qrucible.ai'
  hostedZoneId?: string;    // Route53 hosted zone ID (if DNS is on Route53)
  hostedZoneName?: string;  // e.g., 'qrucible.ai'
  tags?: Record<string, string>;
}

export class ForgeAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ForgeAppStackProps) {
    super(scope, id, props);

    // ── ECR Repository ──────────────────────────────────────────────────────
    const ecrRepo = new ecr.Repository(this, 'ForgeAppRepo', {
      repositoryName: 'forge-app-test',
      imageScanOnPush: true,
      lifecycleRules: [
        {
          description: 'Keep last 10 images',
          maxImageCount: 10,
          rulePriority: 1,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Secrets ──────────────────────────────────────────────────────────────
    // Placeholder secrets — values must be set manually in AWS Console or CLI
    const secretNames = [
      'supabase-url',
      'supabase-service-key',
      'supabase-anon-key',
      'supabase-jwt-secret',
      'anthropic-api-key',
    ];

    const secrets: Record<string, ecs.Secret> = {};
    for (const name of secretNames) {
      const secret = new secretsmanager.Secret(this, `Secret${name.replace(/-/g, '')}`, {
        secretName: `forge/test/${name}`,
        description: `FORGE test env — ${name}`,
      });
      const envName = name.replace(/-/g, '_').toUpperCase();
      secrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    // ── CloudWatch Log Group ────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'ForgeAppLogGroup', {
      logGroupName: '/forge/ecs/forge-app-test',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Task Execution Role ─────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/test/*`],
    }));

    // ── Task Role (runtime) ─────────────────────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Allow ECS Exec for debugging
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // ── ECS Task Definition ─────────────────────────────────────────────────
    const taskDef = new ecs.Ec2TaskDefinition(this, 'ForgeAppTaskDef', {
      family: 'forge-app-test',
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    const container = taskDef.addContainer('forge-app', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      memoryLimitMiB: 512,
      cpu: 256,
      essential: true,
      environment: {
        NODE_ENV: 'production',
        FORGE_DOMAIN: props.domainName,
        PORT: '3000',
        DEV_MODE: 'false',
        AXIOM_ENABLED: 'true',
        AXIOM_STRICT: 'false',
      },
      secrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'forge-app',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    // ── Application Load Balancer ───────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ForgeTestAlb', {
      loadBalancerName: 'forge-test-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnets: props.publicSubnets },
    });

    // HTTP → HTTPS redirect
    this.alb.addListener('HttpRedirect', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // ACM Certificate (DNS validation via Route53 or manual)
    let certificate: acm.ICertificate;
    
    if (props.hostedZoneId && props.hostedZoneName) {
      // Auto-validate via Route53
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });

      certificate = new acm.Certificate(this, 'ForgeTestCert', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // Route53 alias record → ALB
      new route53.ARecord(this, 'ForgeTestDns', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(this.alb),
        ),
        ttl: cdk.Duration.minutes(5),
      });
    } else {
      // Manual DNS validation — user must add CNAME records
      certificate = new acm.Certificate(this, 'ForgeTestCert', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(),
      });
    }

    // HTTPS listener with target group
    const httpsListener = this.alb.addListener('Https', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    });

    // ── ECS Service ─────────────────────────────────────────────────────────
    const service = new ecs.Ec2Service(this, 'ForgeAppService', {
      cluster: props.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      serviceName: 'forge-app-test',
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      placementStrategies: [
        ecs.PlacementStrategy.spreadAcrossInstances(),
      ],
      capacityProviderStrategies: [
        {
          capacityProvider: 'forge-graviton-spot',  // Provider A — always-on
          weight: 1,
          base: 1,
        },
      ],
    });

    // Register with ALB target group
    httpsListener.addTargets('ForgeAppTarget', {
      targets: [service],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyHttpCodes: '200',
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    this.albDnsName = new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name — point forgetest.qrucible.ai CNAME here',
      exportName: `ForgeTestAlbDns-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'ALB ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for forge-app-test images',
      exportName: `ForgeTestEcrUri-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS service name',
    });

    new cdk.CfnOutput(this, 'DomainSetup', {
      value: props.hostedZoneId
        ? `DNS auto-configured: ${props.domainName} → ALB`
        : `MANUAL: Create CNAME ${props.domainName} → ${this.alb.loadBalancerDnsName}`,
      description: 'DNS configuration status',
    });
  }
}
