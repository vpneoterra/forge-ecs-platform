/**
 * Per-environment VPC addressing.
 * 'dev' keeps the legacy 10.0.0.0/16 range that the live VPC already uses
 * (changing it would replace the live VPC). Other envs get distinct /16s so
 * two environments can be VPC-peered (overlapping CIDRs cannot peer).
 */
export function vpcSecondOctet(forgeEnv: string): number {
  switch (forgeEnv) {
    case 'dev':  return 0;   // 10.0.0.0/16  -- LEGACY, do not change
    case 'dev2': return 1;   // 10.1.0.0/16
    case 'prod': return 2;   // 10.2.0.0/16
    default:     return 1;   // any other env -> 10.1.0.0/16
  }
}

export function vpcCidr(forgeEnv: string): string {
  return `10.${vpcSecondOctet(forgeEnv)}.0.0/16`;
}

/**
 * Extra private subnets (by ID) that exist in the live account but are NOT
 * modeled by the CDK VPC construct, and that always-on EC2 services must be
 * allowed to place into.
 *
 * Why this exists: ForgeNetworkStack builds the dev/dev2 VPC with `maxAzs = 1`
 * (single-AZ for cost), so CDK only knows about the us-east-1a PrivateSubnet1.
 * A second private subnet in us-east-1b (PrivateSubnet2B, 10.1.2.0/24) plus its
 * EFS mount target were added to the live dev2 VPC by hand to give forge-devops
 * (3072 CPU) a second placement host when 1a is full. Because CDK doesn't model
 * it, every `cdk deploy` would otherwise re-pin forge-devops to 1a-only and the
 * task gets stuck in PROVISIONING (az=null) whenever 1a lacks capacity.
 *
 * Pinning the subnet by ID here (rather than flipping maxAzs to 2) avoids CDK
 * trying to create brand-new subnets / reshuffle CIDRs in the legacy live VPC.
 * Override per-deploy with `-c devopsExtraSubnetIds=subnet-aaa,subnet-bbb`.
 */
export function extraDevopsSubnetIds(forgeEnv: string): string[] {
  switch (forgeEnv) {
    case 'dev2': return ['subnet-05242c7a4d15294ba']; // us-east-1b PrivateSubnet2B (hand-created)
    default:     return [];
  }
}
