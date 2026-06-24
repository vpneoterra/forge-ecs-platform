/**
 * Synth-level regression guard for the OMNI-rollout deadlock fixed in
 * fix/omni-rollout-network-export-deadlock.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Run 27872944123 (env_name=dev2) failed at "CDK deploy ForgeApp (pin forge-omni to
 * pushed digest)" with:
 *
 *   ForgeNetwork-dev2 | UPDATE_ROLLBACK_IN_P | Delete canceled. Cannot delete export
 *   ForgeNetwork-dev2:ExportsOutputRefPrivateSubnet2B0A657E94 as it is in use by
 *   ForgeCompute-dev2.
 *
 * (The run-log error abbreviates the export name; the actual CDK-generated key is
 * `ExportsOutputRefForgeVpcPrivateSubnet2Subnet9426FEDC82246ABD`, a Ref to subnet
 * logical id `ForgeVpcPrivateSubnet2Subnet9426FEDC`. The VPC construct id `ForgeVpc`
 * has been constant since the initial commit, so the export key is deterministic and
 * the meaningful invariant is simply: the second private subnet must keep existing.)
 *
 * Root cause: the live ForgeNetwork-dev2 VPC was deployed dual-AZ (commit 6afe523),
 * so CDK auto-generated a cross-stack export for the second private subnet which
 * ForgeCompute-dev2 imports for task placement. A later refactor (e10d45d) reset
 * `maxAzs` to `isProd ? 2 : 1`, dropping dev2 to a single AZ. Synthesizing only 1 AZ
 * removes ForgeVpcPrivateSubnet2, so `cdk deploy ForgeApp-dev2` (which pulls
 * ForgeNetwork-dev2 into its closure) tries to delete that in-use export ->
 * CloudFormation refuses -> ForgeNetwork-dev2 UPDATE_ROLLBACK -> the deploy aborts
 * and forge-omni never rolls.
 *
 * The subnet logical id/hash is fixed by the construct path
 * (ForgeNetwork-dev2/ForgeVpc/PrivateSubnet2/Subnet) and is independent of HOW
 * `maxAzs` is computed, so restoring dev2 to dual-AZ reproduces the live stack's
 * subnet + export byte-for-byte: CloudFormation sees no diff, attempts no delete,
 * and the deadlock cannot recur.
 *
 * The fix makes AZ count env-aware (`forgeEnv === 'dev' ? 1 : 2`) so dev2 keeps its
 * second private subnet and the export stays stable (no delete, no deadlock), while
 * the legacy single-AZ dev VPC (10.0.0.0/16) is untouched.
 *
 * HOW THE EXPORT IS REPRODUCED HERE
 * ---------------------------------
 * CDK only emits the `ExportsOutputRefPrivateSubnet2...` output when *another* stack
 * references the subnet cross-stack (exactly what ForgeCompute does via
 * `props.privateSubnets`). So each case below synthesizes ForgeNetworkStack plus a
 * tiny consumer stack that references every private subnet — mirroring the real
 * producer/consumer wiring — and then asserts on the network template. They deploy
 * nothing. They must FAIL on the pre-fix tree (dev2 single-AZ) and PASS after.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ForgeNetworkStack } from '../lib/forge-network-stack';

/**
 * Synthesize the network stack together with a consumer that imports every private
 * subnet cross-stack (the way ForgeCompute does), forcing CDK to generate the same
 * auto-exports the live stacks have. Returns the NETWORK stack's template.
 */
function synthNetworkWithConsumer(forgeEnv: string): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const network = new ForgeNetworkStack(app, `ForgeNetwork-${forgeEnv}`, {
    env,
    forgeEnv,
  });
  const consumer = new cdk.Stack(app, `ForgeCompute-${forgeEnv}`, { env });
  // Reference each private subnet from the consumer stack -> CDK emits a cross-stack
  // export per subnet on the network stack (mirrors ForgeCompute task placement).
  network.privateSubnets.forEach((subnet, i) => {
    new cdk.CfnOutput(consumer, `UsesSubnet${i}`, { value: subnet.subnetId });
  });
  return Template.fromStack(network);
}

// Deterministic logical IDs CDK assigns to this VPC's private subnets and the
// auto-generated cross-stack export for the second one. Stable because the VPC
// construct id (ForgeVpc), subnetConfiguration, and CIDR are all fixed in source.
const PRIVATE_SUBNET_1 = 'ForgeVpcPrivateSubnet1SubnetEA3D7460';
const PRIVATE_SUBNET_2 = 'ForgeVpcPrivateSubnet2Subnet9426FEDC';
const PRIVATE_SUBNET_2_EXPORT = 'ExportsOutputRefForgeVpcPrivateSubnet2Subnet9426FEDC82246ABD';

/** Logical IDs of the private subnets CDK generates for this VPC. */
function privateSubnetLogicalIds(template: Template): string[] {
  const subnets = template.findResources('AWS::EC2::Subnet');
  return Object.keys(subnets).filter((id) => id.includes('PrivateSubnet'));
}

describe('ForgeNetworkStack dev2 (GREEN) — second private subnet + stable export', () => {
  const template = synthNetworkWithConsumer('dev2');

  test('synthesizes two private subnets (dual-AZ)', () => {
    const ids = privateSubnetLogicalIds(template);
    expect(ids).toContain(PRIVATE_SUBNET_1);
    expect(ids).toContain(PRIVATE_SUBNET_2);
    expect(ids.length).toBe(2);
  });

  test('exports the second private subnet Ref (the export ForgeCompute-dev2 imports)', () => {
    // This is the in-use export from the live deadlock. Keeping dev2 dual-AZ keeps it
    // present and byte-stable so CloudFormation never attempts to delete it.
    template.hasOutput(PRIVATE_SUBNET_2_EXPORT, {
      Value: { Ref: PRIVATE_SUBNET_2 },
    });
  });
});

describe('ForgeNetworkStack dev (legacy BLUE) — single-AZ, no second subnet', () => {
  const template = synthNetworkWithConsumer('dev');

  test('synthesizes exactly one private subnet (single-AZ legacy VPC)', () => {
    const ids = privateSubnetLogicalIds(template);
    expect(ids).toContain(PRIVATE_SUBNET_1);
    expect(ids).not.toContain(PRIVATE_SUBNET_2);
    expect(ids.length).toBe(1);
  });

  test('does NOT emit the PrivateSubnet2 cross-stack export', () => {
    const outputs = template.findOutputs(PRIVATE_SUBNET_2_EXPORT);
    expect(Object.keys(outputs).length).toBe(0);
  });
});
