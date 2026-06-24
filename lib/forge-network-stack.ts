/**
 * ForgeNetworkStack
 * VPC with NAT Instance (t4g.nano) instead of NAT Gateway -- saves ~$29/month.
 * Single-AZ for dev (minimum cost), dual-AZ for prod.
 * VPC endpoints: S3 Gateway (free) + ECR (needed for image pulls).
 * Security groups for ECS tasks, ALB, RDS, EFS.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { vpcCidr } from './config/network-config';

export interface ForgeNetworkStackProps extends cdk.StackProps {
  forgeEnv: string;
  tags?: Record<string, string>;
}

export class ForgeNetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly rdsSecurityGroup: ec2.SecurityGroup;
  public readonly efsSecurityGroup: ec2.SecurityGroup;
  public readonly natInstanceId: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: ForgeNetworkStackProps) {
    super(scope, id, props);

    // The managed ec2.Vpc construct is SINGLE-AZ for dev and dev2; only prod is
    // dual-AZ. This matches what is actually deployed:
    //   'dev'  -> 1 AZ: legacy 10.0.0.0/16 VPC was deployed single-AZ.
    //   'dev2' -> 1 AZ for the ForgeVpc construct (live ForgeNetwork-dev2 has exactly
    //             one auto private subnet, ForgeVpcPrivateSubnet1 = 10.1.1.0/24 in
    //             us-east-1a). dev2's SECOND private subnet is NOT a 2nd construct AZ:
    //             it is an explicitly-declared subnet (PrivateSubnet2B, below) added on
    //             top of the single-AZ VPC. Driving dev2 to maxAzs=2 makes CDK's IP
    //             allocator renumber Private1 to 10.1.2.0/24 (requires replacement of
    //             the subnet carrying the running forge-omni task) and synthesize a new
    //             ForgeVpcPrivateSubnet2 while destroying the live PrivateSubnet2B --
    //             an outage. So dev2 stays single-AZ here and re-declares the live 2B
    //             subnet verbatim below.
    //   'prod' -> 2 AZs.
    const maxAzs = props.forgeEnv === 'prod' ? 2 : 1;

    // ── VPC ─────────────────────────────────────────────────────────────────
    // NAT is handled by a NAT instance below, so we disable CDK's managed NAT.
    this.vpc = new ec2.Vpc(this, 'ForgeVpc', {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr(props.forgeEnv)),
      maxAzs,
      natGateways: 0, // We use a NAT instance instead
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;

    // ── NAT Instance (t4g.nano Spot) -- replaces NAT Gateway ─────────────────
    // fck-nat: community-maintained Graviton NAT instance AMI
    // Saves ~$29/month vs NAT Gateway ($3/month vs $32/month)
    const natRole = new iam.Role(this, 'NatInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const natSecurityGroup = new ec2.SecurityGroup(this, 'NatSg', {
      vpc: this.vpc,
      description: 'NAT instance -- allow all outbound, allow inbound from private subnets',
      allowAllOutbound: true,
    });
    natSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all traffic from VPC CIDR',
    );

    // fck-nat ARM64 AMI (us-east-1) -- community-maintained cost-optimized NAT instance
    // See https://fck-nat.dev for regional AMI IDs
    const natAmi = ec2.MachineImage.lookup({
      name: 'fck-nat-al2023-*-arm64-ebs',
      owners: ['568608671756'], // fck-nat official owner
    });

    const natLaunchTemplate = new ec2.LaunchTemplate(this, 'NatLaunchTemplate', {
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: natAmi,
      role: natRole,
      // securityGroup and associatePublicIpAddress are set via CfnInstance networkInterfaces
      // to avoid the "Network interfaces and an instance-level subnet ID" conflict
      // No spot options -- t4g.nano on-demand is only $0.0042/hr (~$3/month)
      // Spot saves <$1/month but adds complexity and interruption risk for NAT
      userData: ec2.UserData.forLinux(),
    });

    // Deploy NAT instance in first public subnet
    // NOTE: Cannot set subnetId at instance level when launch template has networkInterfaces
    // (CDK creates networkInterfaces when securityGroup + associatePublicIpAddress are both set)
    const natInstance = new ec2.CfnInstance(this, 'NatInstance', {
      launchTemplate: {
        launchTemplateId: natLaunchTemplate.launchTemplateId,
        version: natLaunchTemplate.latestVersionNumber,
      },
      networkInterfaces: [{
        deviceIndex: '0',
        subnetId: this.publicSubnets[0].subnetId,
        associatePublicIpAddress: true,
        groupSet: [natSecurityGroup.securityGroupId],
      }],
      sourceDestCheck: false, // Critical: must be false for NAT to work
      tags: [{ key: 'Name', value: `forge-nat-${props.forgeEnv}` }],
    });

    // Elastic IP for stable NAT instance address
    const natEip = new ec2.CfnEIP(this, 'NatEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `forge-nat-eip-${props.forgeEnv}` }],
    });

    new ec2.CfnEIPAssociation(this, 'NatEipAssoc', {
      eip: natEip.ref,
      instanceId: natInstance.ref,
    });

    // Route private subnets -> NAT instance
    for (let i = 0; i < this.privateSubnets.length; i++) {
      const subnet = this.privateSubnets[i] as ec2.Subnet;
      new ec2.CfnRoute(this, `NatRoute${i}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        instanceId: natInstance.ref,
      });
    }

    // ── dev2 (GREEN): explicit 2nd-AZ private subnet (us-east-1b) ─────────────
    // The live ForgeNetwork-dev2 manages a second private subnet
    // (subnet-05242c7a4d15294ba, 10.1.2.0/24, us-east-1b) declared explicitly on top
    // of the single-AZ ForgeVpc so the GREEN kernel (forge-devops Ec2Service and the
    // ForgeCompute-dev2 ASG) can place tasks in 1b. It was deployed from an
    // out-of-band tree and never committed, so source drifted from live. Because the
    // committed stack omitted it, any deploy pulling ForgeNetwork-dev2 into its
    // closure (e.g. `cdk deploy ForgeApp-dev2`) would try to DELETE this in-use subnet
    // and the in-use cross-stack export below -> CloudFormation refuses ->
    // ForgeNetwork-dev2 UPDATE_ROLLBACK -> the deploy aborts and forge-omni never rolls
    // (run 27872944123). Re-declaring it here with the EXACT deployed logical IDs and
    // properties makes synth == live so CloudFormation sees no change. dev2 only.
    let privateSubnet2BRt: ec2.CfnRouteTable | undefined;
    if (props.forgeEnv === 'dev2') {
      const privateSubnet2B = new ec2.CfnSubnet(this, 'PrivateSubnet2B', {
        vpcId: this.vpc.vpcId,
        cidrBlock: '10.1.2.0/24',
        availabilityZone: 'us-east-1b',
        mapPublicIpOnLaunch: false,
        tags: [{ key: 'Name', value: 'ForgeNetwork-dev2/ForgeVpc/PrivateSubnet2B' }],
      });

      privateSubnet2BRt = new ec2.CfnRouteTable(this, 'PrivateSubnet2BRt', {
        vpcId: this.vpc.vpcId,
        tags: [{ key: 'Name', value: 'ForgeNetwork-dev2/ForgeVpc/PrivateSubnet2B' }],
      });

      new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnet2BRtAssoc', {
        routeTableId: privateSubnet2BRt.ref,
        subnetId: privateSubnet2B.ref,
      });

      new ec2.CfnRoute(this, 'PrivateSubnet2BNatRoute', {
        routeTableId: privateSubnet2BRt.ref,
        destinationCidrBlock: '0.0.0.0/0',
        instanceId: natInstance.ref,
      });

      // ForgeCompute-dev2's ASG places instances in 1b by importing the auto-share
      // export Ref(PrivateSubnet2B). Re-emit that SAME in-use export (CDK reproduces
      // logical id `ExportsOutputRefPrivateSubnet2B0A657E94`) so deploying
      // ForgeApp-dev2 -- which depends on ForgeNetwork but NOT ForgeCompute -- never
      // attempts to delete an export ForgeCompute-dev2 still consumes. This is the
      // documented pattern for retaining a cross-stack export still in use.
      this.exportValue(privateSubnet2B.ref);

      new cdk.CfnOutput(this, 'PrivateSubnet2BId', {
        value: privateSubnet2B.ref,
        description: '2nd-AZ private subnet ID (GREEN kernel multi-AZ)',
        exportName: 'ForgePrivateSubnet2Id-dev2',
      });
    }

    // ── VPC Endpoints ────────────────────────────────────────────────────────
    // S3 Gateway endpoint (free -- no data transfer charges through NAT)
    const s3Endpoint = this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });
    // dev2's explicit 2B route table is invisible to the PRIVATE_WITH_EGRESS subnet
    // selector (it belongs to the hand-declared PrivateSubnet2B, not a ForgeVpc auto
    // subnet), but the live S3 endpoint routes it too. Attach it so synth == live.
    if (privateSubnet2BRt) {
      const cfnS3Endpoint = s3Endpoint.node.defaultChild as ec2.CfnVPCEndpoint;
      cfnS3Endpoint.routeTableIds = [
        ...(cfnS3Endpoint.routeTableIds ?? []),
        privateSubnet2BRt.ref,
      ];
    }

    // ECR Interface endpoints (required for private subnet image pulls)
    // Cost: ~$7.30/month each but saves more in NAT data transfer for large images
    const ecrEndpointSg = new ec2.SecurityGroup(this, 'EcrEndpointSg', {
      vpc: this.vpc,
      description: 'ECR VPC endpoint -- allow HTTPS from ECS tasks',
      allowAllOutbound: false,
    });
    ecrEndpointSg.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'HTTPS from VPC',
    );

    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [ecrEndpointSg],
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [ecrEndpointSg],
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // ── Security Groups ──────────────────────────────────────────────────────

    // ALB Security Group (internet-facing entry point via Nginx)
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB -- allow HTTP/HTTPS from internet',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    // ECS Tasks Security Group
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: 'ECS tasks -- allow inbound from ALB and within ECS',
      allowAllOutbound: true,
    });
    // Allow all traffic within ECS (service-to-service via Cloud Map)
    this.ecsSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.allTraffic(),
      'Inter-service communication',
    );
    // Allow from ALB
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.allTcp(),
      'From ALB',
    );
    // Allow from VPC CIDR (NAT instance health checks, bastion access)
    this.ecsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(22),
      'SSH from VPC (emergency)',
    );

    // RDS Security Group
    this.rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: this.vpc,
      description: 'RDS PostgreSQL -- allow only from ECS tasks',
      allowAllOutbound: false,
    });
    this.rdsSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from ECS',
    );

    // EFS Security Group
    this.efsSecurityGroup = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      description: 'EFS -- allow NFS from ECS tasks',
      allowAllOutbound: false,
    });
    this.efsSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(2049),
      'NFS from ECS',
    );

    // ── Outputs ──────────────────────────────────────────────────────────────
    this.natInstanceId = new cdk.CfnOutput(this, 'NatInstanceId', {
      value: natInstance.ref,
      description: 'NAT Instance ID -- use this to hibernate (stop) the instance',
      exportName: `ForgeNatInstanceId-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'NatPublicIp', {
      value: natEip.ref,
      description: 'NAT Instance Elastic IP (stable public IP for egress traffic)',
      exportName: `ForgeNatPublicIp-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `ForgeVpcId-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.privateSubnets.map(s => s.subnetId).join(','),
      description: 'Private subnet IDs (comma-separated)',
      exportName: `ForgePrivateSubnetIds-${props.forgeEnv}`,
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: this.publicSubnets.map(s => s.subnetId).join(','),
      description: 'Public subnet IDs (comma-separated)',
      exportName: `ForgePublicSubnetIds-${props.forgeEnv}`,
    });
  }
}
