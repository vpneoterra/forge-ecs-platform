/**
 * Synth-level regression guard for the OMNI-rollout export-in-use deadlock
 * (run 27872944123, env_name=dev2).
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `cdk deploy ForgeApp-dev2` failed at the deploy step with:
 *
 *   ForgeNetwork-dev2 | UPDATE_ROLLBACK_IN_P | Delete canceled. Cannot delete export
 *   ForgeNetwork-dev2:ExportsOutputRefPrivateSubnet2B0A657E94 as it is in use by
 *   ForgeCompute-dev2.
 *
 * GROUND TRUTH (verified live, account 266087050444, us-east-1, 2026-06-24)
 * -------------------------------------------------------------------------
 * The deployed ForgeNetwork-dev2 stack MANAGES (it is NOT a hand-built/imported VPC):
 *   - a SINGLE-AZ ForgeVpc: ForgeVpcPublicSubnet1 (10.1.0.0/24, 1a) +
 *     ForgeVpcPrivateSubnet1 (10.1.1.0/24, 1a); NO ForgeVpcPrivateSubnet2.
 *   - an explicitly-declared second private subnet PrivateSubnet2B
 *     (subnet-05242c7a4d15294ba, 10.1.2.0/24, us-east-1b) + PrivateSubnet2BRt +
 *     PrivateSubnet2BRtAssoc + PrivateSubnet2BNatRoute, added on top of the VPC.
 *   - outputs PrivateSubnet2BId (export ForgePrivateSubnet2Id-dev2) and the auto-share
 *     export ExportsOutputRefPrivateSubnet2B0A657E94 (Ref -> PrivateSubnet2B), which
 *     ForgeCompute-dev2's ASG imports to place instances in 1b.
 *
 * The 2B resources were deployed from an out-of-band tree and never committed, so the
 * committed network stack dropped them. Any deploy that pulls ForgeNetwork-dev2 into
 * its closure then tries to DELETE the in-use subnet + export -> CloudFormation
 * refuses -> UPDATE_ROLLBACK -> forge-omni never rolls.
 *
 * THE FIX
 * -------
 * dev2 keeps the single-AZ ForgeVpc and re-declares PrivateSubnet2B (and its route
 * table/assoc/route/exports) verbatim with the exact deployed logical IDs/properties,
 * so synth == live and CloudFormation attempts no change. Setting dev2 to maxAzs=2
 * instead (PR #140) was DESTRUCTIVE: it renumbers the live Private1 (requires
 * replacement of the subnet carrying the running forge-omni task) and destroys
 * PrivateSubnet2B. This test fails on that tree and passes on the fix.
 *
 * The 2B export is emitted unconditionally via stack.exportValue, so the network stack
 * can be synthesized standalone here (no consumer stack required).
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ForgeNetworkStack } from '../lib/forge-network-stack';

function synthNetwork(forgeEnv: string): Template {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const network = new ForgeNetworkStack(app, `ForgeNetwork-${forgeEnv}`, { env, forgeEnv });
  return Template.fromStack(network);
}

// Deterministic logical IDs CDK assigns to this VPC's first private subnet (stable
// because the VPC construct id `ForgeVpc`, subnetConfiguration, and CIDR are fixed),
// the second AZ's auto subnet that maxAzs=2 WOULD create, and the explicit 2B subnet.
const PRIVATE_SUBNET_1 = 'ForgeVpcPrivateSubnet1SubnetEA3D7460';
const FORGEVPC_PRIVATE_SUBNET_2 = 'ForgeVpcPrivateSubnet2Subnet9426FEDC';
const EXPLICIT_SUBNET_2B = 'PrivateSubnet2B';
const SUBNET_2B_EXPORT = 'ExportsOutputRefPrivateSubnet2B0A657E94';

/** Logical IDs of every Subnet in the template. */
function subnetLogicalIds(template: Template): string[] {
  return Object.keys(template.findResources('AWS::EC2::Subnet'));
}

describe('ForgeNetworkStack dev2 (GREEN) — single-AZ ForgeVpc + explicit PrivateSubnet2B', () => {
  const template = synthNetwork('dev2');

  test('ForgeVpc is single-AZ: exactly one auto private subnet, no ForgeVpcPrivateSubnet2', () => {
    const ids = subnetLogicalIds(template);
    expect(ids).toContain(PRIVATE_SUBNET_1);
    expect(ids).not.toContain(FORGEVPC_PRIVATE_SUBNET_2);
  });

  test('re-declares the live explicit 2B subnet (10.1.2.0/24, us-east-1b) verbatim', () => {
    template.hasResourceProperties('AWS::EC2::Subnet', {
      CidrBlock: '10.1.2.0/24',
      AvailabilityZone: 'us-east-1b',
      Tags: [{ Key: 'Name', Value: 'ForgeNetwork-dev2/ForgeVpc/PrivateSubnet2B' }],
    });
    expect(subnetLogicalIds(template)).toContain(EXPLICIT_SUBNET_2B);
  });

  test('routes 2B to the NAT instance via its own route table', () => {
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '0.0.0.0/0',
      InstanceId: { Ref: 'NatInstance' },
      RouteTableId: { Ref: 'PrivateSubnet2BRt' },
    });
    template.hasResourceProperties('AWS::EC2::SubnetRouteTableAssociation', {
      SubnetId: { Ref: EXPLICIT_SUBNET_2B },
      RouteTableId: { Ref: 'PrivateSubnet2BRt' },
    });
  });

  test('emits the in-use cross-stack export ForgeCompute-dev2 imports', () => {
    template.hasOutput(SUBNET_2B_EXPORT, {
      Value: { Ref: EXPLICIT_SUBNET_2B },
      Export: { Name: 'ForgeNetwork-dev2:ExportsOutputRefPrivateSubnet2B0A657E94' },
    });
  });

  test('exposes PrivateSubnet2BId for GREEN multi-AZ kernel placement', () => {
    template.hasOutput('PrivateSubnet2BId', {
      Value: { Ref: EXPLICIT_SUBNET_2B },
      Export: { Name: 'ForgePrivateSubnet2Id-dev2' },
    });
  });
});

describe('ForgeNetworkStack dev (legacy BLUE) — single-AZ, no PrivateSubnet2B', () => {
  const template = synthNetwork('dev');

  test('synthesizes exactly one private subnet (single-AZ legacy VPC)', () => {
    const ids = subnetLogicalIds(template).filter((id) => id.includes('Private'));
    expect(ids).toContain(PRIVATE_SUBNET_1);
    expect(ids).not.toContain(FORGEVPC_PRIVATE_SUBNET_2);
    expect(ids).not.toContain(EXPLICIT_SUBNET_2B);
    expect(ids.length).toBe(1);
  });

  test('does NOT declare PrivateSubnet2B or emit its export', () => {
    expect(subnetLogicalIds(template)).not.toContain(EXPLICIT_SUBNET_2B);
    expect(Object.keys(template.findOutputs(SUBNET_2B_EXPORT)).length).toBe(0);
    expect(Object.keys(template.findOutputs('PrivateSubnet2BId')).length).toBe(0);
  });
});
