/**
 * ForgeAppStack -- FORGE Web Application (test branch)
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and Fargate service. Does NOT depend on ForgeComputeStack.
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed) + $0.008/LCU-hour
 *   - Fargate (256 CPU / 512 MB): ~$9/month (on-demand), ~$6/month (Spot)
 *   - Secrets Manager: $0.40/secret/month x 5 = $2/month
 *   - CloudWatch Logs: ~$0.50/month (7-day retention)
 *   Total: ~$25/month
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface ForgeAppStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'forgetest.qrucible.ai'
  tags?: Record<string, string>;
}

export class ForgeAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: ForgeAppStackProps) {
    super(scope, id, props);

    // -- ECS Cluster (Fargate only -- no EC2 instances needed) ---------------
    this.ecsCluster = new ecs.Cluster(this, 'ForgeAppCluster', {
      clusterName: `forge-app-${props.forgeEnv}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false, // Save cost in dev
    });

    // -- ECR Repository (import existing or create) --------------------------
    // Use existing repo created by the CI/CD pipeline
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'ForgeAppRepo', 'forge-app-test',
    );

    // -- Secrets --------------------------------------------------------------
    const secretNames = [
      'supabase-url',
      'supabase-service-key',
      'supabase-anon-key',
      'supabase-jwt-secret',
      'anthropic-api-key',
      'tripo-api-key',
      'together-api-key',
      'lucid-token',
    ];

    const secrets: Record<string, ecs.Secret> = {};
    for (const name of secretNames) {
      const secret = new secretsmanager.Secret(this, `Secret${name.replace(/-/g, '')}`, {
        secretName: `forge/test/${name}`,
        description: `FORGE test env -- ${name}`,
      });
      const envName = name.replace(/-/g, '_').toUpperCase();
      secrets[envName] = ecs.Secret.fromSecretsManager(secret);
    }

    // -- CloudWatch Log Group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'ForgeAppLogGroup', {
      logGroupName: '/forge/ecs/forge-app-test',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -- Task Execution Role --------------------------------------------------
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
    // Allow pulling from ECR
    ecrRepo.grantPull(executionRole);

    // -- Task Role (runtime) --------------------------------------------------
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // -- Fargate Task Definition ----------------------------------------------
    const taskDef = new ecs.FargateTaskDefinition(this, 'ForgeAppTaskDef', {
      family: 'forge-app-test',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer('forge-app', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      essential: true,
      environment: {
        NODE_ENV: 'production',
        FORGE_DOMAIN: props.domainName,
        PORT: '3000',
        DEV_MODE: 'false',
        AXIOM_ENABLED: 'true',
        AXIOM_STRICT: 'false',
        COMPUTE_HOST: '89.167.79.141',
        PICOGK_API_URL: 'http://89.167.79.141:8015',
        SYSML_API_URL: 'http://89.167.79.141:8003',
        HETZNER_COMPUTE_URL: 'http://89.167.79.141:8001',
        LUCID_URL: 'https://api-lucid.qrucible.ai',
        FREECAD_MCP_URL: 'http://89.167.79.141:8016',
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
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    // -- ALB requires 2 AZs -- ensure we have enough public subnets -----------
    // Dev VPC may have only 1 AZ; create a second public subnet if needed.
    let albSubnets: ec2.ISubnet[] = [...props.publicSubnets];
    if (albSubnets.length < 2) {
      // Pick an AZ different from the first subnet
      const usedAz = albSubnets[0].availabilityZone;
      const allAzs = cdk.Stack.of(this).availabilityZones;
      const secondAz = allAzs.find(az => az !== usedAz) ?? allAzs[1] ?? `${this.region}b`;

      const albSubnet2 = new ec2.PublicSubnet(this, 'AlbSubnet2', {
        vpcId: props.vpc.vpcId,
        cidrBlock: '10.0.128.0/24',  // High range to avoid existing subnets
        availabilityZone: secondAz,
        mapPublicIpOnLaunch: true,
      });
      // Route internet traffic through the VPC's internet gateway
      const igwId = props.vpc.internetGatewayId!;
      albSubnet2.addDefaultInternetRoute(igwId, props.vpc.internetConnectivityEstablished);
      albSubnets.push(albSubnet2);
    }

    // -- Application Load Balancer --------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ForgeTestAlb', {
      loadBalancerName: 'forge-test-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnets: albSubnets },
    });

    // -- ACM Certificate (DNS validation -- add CNAME in Hetzner manually) ----
    const certificate = new acm.Certificate(this, 'ForgeAppCert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(), // No hosted zone -- manual DNS validation
    });

    // HTTPS listener (primary)
    const httpsListener = this.alb.addListener('Https', {
      port: 443,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
    });

    // HTTP listener -- redirect to HTTPS
    this.alb.addListener('Http', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // -- Fargate Service -------------------------------------------------------
    const service = new ecs.FargateService(this, 'ForgeAppService', {
      cluster: this.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: 'forge-app-test',
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false, // Private subnet, uses NAT for outbound
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
    });

    this.serviceName = 'forge-app-test';

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

    // -- Outputs ---------------------------------------------------------------
    this.albDnsName = new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS name -- point forge domain CNAME here',
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

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: `ForgeAppClusterName-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'DomainSetup', {
      value: `MANUAL: Create CNAME ${props.domainName} -> ${this.alb.loadBalancerDnsName}`,
      description: 'DNS configuration -- add this CNAME in Hetzner DNS',
    });
  }
}
