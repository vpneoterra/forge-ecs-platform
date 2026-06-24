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
 * Why this exists: the hand-created us-east-1b subnet PrivateSubnet2B
 * (subnet-05242c7a4d15294ba, 10.1.2.0/24) plus its EFS mount target were added to
 * the live dev2 VPC by hand to give forge-devops (3072 CPU) an extra placement
 * host. CDK does not model this specific hand-created subnet, so without pinning it
 * here every `cdk deploy` would re-pin forge-devops to the CDK-modeled subnets only
 * and the task can get stuck in PROVISIONING (az=null) when its AZ lacks capacity.
 *
 * NOTE: dev2 (green) IS modeled dual-AZ by CDK (ForgeNetworkStack maxAzs=2), so its
 * CDK PrivateSubnet1/PrivateSubnet2 are first-class and their exports are stable.
 * This pin is purely ADDITIVE — it does not replace the CDK subnets; it only lets
 * forge-devops also use the extra hand-created 1b subnet. Override per-deploy with
 * `-c devopsExtraSubnetIds=subnet-aaa,subnet-bbb`.
 */
export function extraDevopsSubnetIds(forgeEnv: string): string[] {
  switch (forgeEnv) {
    case 'dev2': return ['subnet-05242c7a4d15294ba']; // us-east-1b PrivateSubnet2B (hand-created)
    default:     return [];
  }
}
