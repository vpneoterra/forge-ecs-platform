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
