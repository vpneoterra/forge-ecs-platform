/**
 * ForgeAppStack -- FORGE Web Application + OMNI API
 *
 * Self-contained Fargate deployment: creates its own ECS cluster, ALB,
 * and two Fargate services (forge-app + forge-omni). Host-header routing
 * on the shared ALB separates traffic:
 *   - forge.qrucible.ai  → forge-app (Node.js, port 3000)
 *   - omni.qrucible.ai   → forge-omni (PicoGK .NET, port 5000)
 *
 * Internal connectivity: forge-app reaches OMNI via Cloud Map private DNS
 * at omni.forge.local:5000 (no public internet hop).
 *
 * Route 53 integration:
 *   - ACM certificate with SAN covering both domains (auto DNS validation)
 *   - A/AAAA Alias records for both domains pointing to the ALB
 *   - No manual DNS updates ever needed -- Route 53 handles everything
 *
 * Cost breakdown:
 *   - ALB: ~$16/month (fixed, shared) + $0.008/LCU-hour
 *   - Fargate forge-app (256 CPU / 512 MB Spot): ~$6/month
 *   - Fargate forge-omni (4096 CPU / 8192 MB Spot): ~$36/month
 *   - Secrets Manager: $0.40/secret/month x 6 = $2.40/month
 *   - CloudWatch Logs: ~$1/month (7-day retention, 2 log groups)
 *   - Route 53 hosted zone: $0.50/month + $0.40/million queries
 *   - ACM certificate: free
 *   - Cloud Map namespace: free (first 1000 instances)
 *   Total: ~$62/month
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
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface ForgeAppStackProps extends cdk.StackProps {
  forgeEnv: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  privateSubnets: ec2.ISubnet[];
  publicSubnets: ec2.ISubnet[];
  domainName: string;       // e.g., 'forge.qrucible.ai'
  omniDomainName: string;   // e.g., 'omni.qrucible.ai'
  hostedZoneDomain: string; // e.g., 'qrucible.ai'
  tags?: Record<string, string>;
}

export class ForgeAppStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albDnsName: cdk.CfnOutput;
  public readonly ecsCluster: ecs.Cluster;
  public readonly serviceName: string;

  constructor(scope: Construct, id: string, props: ForgeAppStackProps) {
    super(scope, id, props);

    // -- Route 53 Hosted Zone (lookup existing) --------------------------------
    // The user has already moved qrucible.ai nameservers to Route 53.
    // We look up the existing hosted zone rather than creating a new one.
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.hostedZoneDomain,
    });

    // -- ECS Cluster (Fargate only -- no EC2 instances needed) ---------------
    this.ecsCluster = new ecs.Cluster(this, 'ForgeAppCluster', {
      clusterName: `forge-app-${props.forgeEnv}`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
      containerInsights: false, // Save cost in dev
    });

    // -- Cloud Map Namespace (private DNS for service discovery) --------------
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ForgeNamespace', {
      name: 'forge.local',
      vpc: props.vpc,
      description: 'FORGE private service discovery',
    });

    // -- ECR Repository (import existing or create) --------------------------
    // Use existing repo created by the CI/CD pipeline
    const ecrRepo = ecr.Repository.fromRepositoryName(
      this, 'ForgeAppRepo', 'forge-app-test',
    );

    const omniEcrRepo = ecr.Repository.fromRepositoryName(
      this, 'OmniRepo', 'forge-omni',
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
        OMNI_API_URL: 'http://omni.forge.local:5000',
        OMNI_HOST: 'omni.forge.local',
        OMNI_PORT: '5000',
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
      idleTimeout: cdk.Duration.seconds(600),  // I2D pipeline: 7 phases × solver steps
    });

    // -- ACM Certificate (DNS validated via Route 53 -- fully automatic) ------
    // Single certificate covers both forge.qrucible.ai and omni.qrucible.ai
    const certificate = new acm.Certificate(this, 'ForgeAppCert', {
      domainName: props.domainName,
      subjectAlternativeNames: [props.omniDomainName],
      validation: acm.CertificateValidation.fromDns(hostedZone),
      // Route 53 validation: CDK automatically creates the CNAME records
      // in the hosted zone. No manual DNS steps needed.
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

    // -- Route 53 Alias Records ------------------------------------------------
    // A records with Alias to ALB -- Route 53 automatically resolves to the
    // ALB's current IPs. No CNAME needed, no manual DNS updates ever.
    new route53.ARecord(this, 'ForgeAlbAlias', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb),
      ),
      comment: 'FORGE app ALB -- managed by CDK',
    });

    // omni.qrucible.ai → same ALB (host-header routing separates traffic)
    new route53.ARecord(this, 'OmniAlbAlias', {
      zone: hostedZone,
      recordName: props.omniDomainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb),
      ),
      comment: 'OMNI API ALB -- managed by CDK',
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

    // Register forge-app as default target group (all traffic not matched by host rules)
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

    // -- OMNI Service (Fargate Spot with Cloud Map) ----------------------------
    const omniLogGroup = new logs.LogGroup(this, 'OmniLogGroup', {
      logGroupName: '/forge/ecs/forge-omni',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const omniTaskDef = new ecs.FargateTaskDefinition(this, 'OmniTaskDef', {
      family: 'forge-omni',
      cpu: 4096,
      memoryLimitMiB: 8192,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    omniEcrRepo.grantPull(executionRole);

    const omniContainer = omniTaskDef.addContainer('omni-api', {
      image: ecs.ContainerImage.fromEcrRepository(omniEcrRepo, 'latest'),
      essential: true,
      environment: {
        DISPLAY: ':99',
        DOTNET_ENVIRONMENT: 'Production',
        PORT: '5000',
      },
      secrets: {
        ANTHROPIC_API_KEY: secrets['ANTHROPIC_API_KEY'],
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: omniLogGroup,
        streamPrefix: 'omni',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:5000/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    omniContainer.addPortMappings({ containerPort: 5000 });

    const omniService = new ecs.FargateService(this, 'OmniService', {
      cluster: this.ecsCluster,
      taskDefinition: omniTaskDef,
      desiredCount: 1,
      serviceName: 'forge-omni',
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      assignPublicIp: false,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnets: props.privateSubnets },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 1 },
      ],
      cloudMapOptions: {
        name: 'omni',
        cloudMapNamespace: namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
    });

    // -- OMNI ALB target group (host-header routing: omni.qrucible.ai) --------
    httpsListener.addTargets('OmniTarget', {
      targets: [omniService],
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.omniDomainName]),
      ],
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

    new cdk.CfnOutput(this, 'OmniServiceDiscovery', {
      value: 'omni.forge.local:5000',
      description: 'OMNI internal endpoint via Cloud Map',
    });

    new cdk.CfnOutput(this, 'OmniPublicDomain', {
      value: `https://${props.omniDomainName}`,
      description: 'OMNI public URL (Route 53 Alias → ALB, host-header routing)',
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
