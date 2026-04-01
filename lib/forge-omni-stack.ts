/**
 * ForgeOmniStack -- OMNI PicoGK Fountain Pen Generator
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and Fargate service. Does NOT depend on ForgeComputeStack.
 *
 * Route 53 integration:
 *   - ACM certificate with automated DNS validation via Route 53
 *   - A/AAAA Alias records pointing to the ALB (auto-follow ALB IP changes)
 *   - No manual DNS updates ever needed -- Route 53 handles everything
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed) + $0.008/LCU-hour
 *   - Fargate (4096 CPU / 16384 MB): ~$70/month (on-demand)
 *   - Secrets Manager: imported (managed outside this stack)
 *   - CloudWatch Logs: ~$0.50/month (7-day retention)
 *   - Route 53 hosted zone: $0.50/month + $0.40/million queries
 *   - ACM certificate: free
 *   Total: ~$88/month
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
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface ForgeOmniStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'omni.qrucible.ai'
  hostedZoneDomain: string; // e.g., 'qrucible.ai'
  tags?: Record<string, string>;
}

export class ForgeOmniStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: ForgeOmniStackProps) {
    super(scope, id, props);

    const env = props.forgeEnv;

    // -- Route 53 Hosted Zone (lookup existing) --------------------------------
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- ECS Cluster (Fargate only -- no EC2 instances needed) ---------------
    this.ecsCluster = new ecs.Cluster(this, 'OmniCluster', {
      clusterName: `omni-${env}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false,
    });

    // -- ECR Repository (import existing) ------------------------------------
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'OmniRepo', 'omni',
    );

    // -- Secrets --------------------------------------------------------------
    const omniApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'SecretOmniApiKey', `forge/${env}/omni-api-key`,
    );

    const secrets: Record<string, ecs.Secret> = {
      API_KEY: ecs.Secret.fromSecretsManager(omniApiKeySecret),
    };

    // -- CloudWatch Log Group ------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'OmniLogGroup', {
      logGroupName: '/forge/ecs/omni',
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
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:forge/${env}/*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/forge/*`],
    }));
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
    const taskDef = new ecs.FargateTaskDefinition(this, 'OmniTaskDef', {
      family: 'omni',
      cpu: 4096,
      memoryLimitMiB: 16384,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer('omni-api', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepo, 'latest'),
      essential: true,
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
        OMNI_DOMAIN: props.domainName,
      },
      secrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'omni',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:5000/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({ containerPort: 5000 });

    // -- ALB requires 2 AZs -- ensure we have enough public subnets -----------
    let albSubnets: ec2.ISubnet[] = [...props.publicSubnets];
    if (albSubnets.length < 2) {
      const usedAz = albSubnets[0].availabilityZone;
      const allAzs = cdk.Stack.of(this).availabilityZones;
      const secondAz = allAzs.find(az => az !== usedAz) ?? allAzs[1] ?? `${this.region}b`;

      const albSubnet2 = new ec2.PublicSubnet(this, 'AlbSubnet2', {
        vpcId: props.vpc.vpcId,
        cidrBlock: '10.0.129.0/24',
        availabilityZone: secondAz,
        mapPublicIpOnLaunch: true,
      });
      const igwId = props.vpc.internetGatewayId!;
      albSubnet2.addDefaultInternetRoute(igwId, props.vpc.internetConnectivityEstablished);
      albSubnets.push(albSubnet2);
    }

    // -- Application Load Balancer --------------------------------------------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'OmniAlb', {
      loadBalancerName: 'omni-alb',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnets: albSubnets },
      idleTimeout: cdk.Duration.seconds(600),
    });

    // -- ACM Certificate (DNS validated via Route 53 -- fully automatic) ------
    const certificate = new acm.Certificate(this, 'OmniCert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
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

    // -- Route 53 Alias Record ------------------------------------------------
    new route53.ARecord(this, 'OmniAlbAlias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb),
      ),
      comment: 'OMNI app ALB -- managed by CDK',
    });

    // -- Fargate Service -------------------------------------------------------
    const service = new ecs.FargateService(this, 'OmniService', {
      cluster: this.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      serviceName: `omni-${env}`,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
    });

    this.serviceName = `omni-${env}`;

    // Register with ALB target group
    httpsListener.addTargets('OmniTarget', {
      targets: [service],
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        path: '/api/health',
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
      description: 'ALB DNS name (Route 53 Alias handles this -- no manual CNAME needed)',
      exportName: `OmniAlbDns-${env}`,
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      description: 'ALB ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for omni images',
      exportName: `OmniEcrUri-${env}`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS service name',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS cluster name',
      exportName: `OmniClusterName-${env}`,
    });

    new cdk.CfnOutput(this, 'DomainSetup', {
      value: `Route 53 Alias: ${props.domainName} -> ALB (automatic, no manual DNS needed)`,
      description: 'DNS is fully managed by Route 53 + CDK',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description: 'ACM certificate ARN (auto-validated via Route 53)',
    });
  }
}
