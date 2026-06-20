/**
 * Unit tests for resolveEcrImage (lib/image-ref.ts) -- the RC2-A/RC2-C image
 * reference contract: OMNI deployments must pin an IMMUTABLE @sha256 digest or an
 * immutable build-SHA tag, and `:latest` is forbidden as a deploy reference.
 *
 * Root cause (program 253f20a6 "Solar Nomad"): the OMNI task def referenced
 * `forge-omni-dev2:latest`; a later (empty) push overwrote the digest `:latest`
 * pointed to, the old digest was GC'd, and every task died with
 * CannotPullContainerError. These tests lock the helper's behaviour so a
 * `:latest` reference can never be synthesized for a repo that requires immutable
 * images.
 */
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { resolveEcrImage } from '../lib/image-ref';

function makeScope(context: Record<string, string> = {}): {
  stack: cdk.Stack;
  repo: ecr.IRepository;
} {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const repo = ecr.Repository.fromRepositoryName(stack, 'Repo', 'forge-omni');
  return { stack, repo };
}

const VALID_DIGEST =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';

describe('resolveEcrImage — immutable-by-default contract (RC2-A/RC2-C)', () => {
  test('throws when no digest/tag is supplied and requireImmutable defaults true', () => {
    const { stack, repo } = makeScope();
    expect(() => resolveEcrImage(stack, repo, 'forgeOmni')).toThrow(
      /no immutable image reference supplied/i,
    );
  });

  test('throws and names both -c context keys to pass', () => {
    const { stack, repo } = makeScope();
    expect(() => resolveEcrImage(stack, repo, 'forgeOmni')).toThrow(
      /forgeOmniImageDigest[\s\S]*forgeOmniImageTag/i,
    );
  });

  test('accepts a valid sha256 digest from context (preferred path)', () => {
    const { stack, repo } = makeScope({ forgeOmniImageDigest: VALID_DIGEST });
    const image = resolveEcrImage(stack, repo, 'forgeOmni');
    expect(image).toBeDefined();
  });

  test('rejects a malformed digest rather than coercing it', () => {
    const { stack, repo } = makeScope({ forgeOmniImageDigest: 'sha256:deadbeef' });
    expect(() => resolveEcrImage(stack, repo, 'forgeOmni')).toThrow(
      /must be a full 'sha256:<64-hex>' digest/i,
    );
  });

  test('accepts an immutable build-SHA tag from context', () => {
    const { stack, repo } = makeScope({ forgeOmniImageTag: 'abc12345' });
    const image = resolveEcrImage(stack, repo, 'forgeOmni');
    expect(image).toBeDefined();
  });

  test("rejects ':latest' explicitly, even when passed as an immutable tag", () => {
    const { stack, repo } = makeScope({ forgeOmniImageTag: 'latest' });
    expect(() => resolveEcrImage(stack, repo, 'forgeOmni')).toThrow(
      /':latest' is a mutable tag and is forbidden/i,
    );
  });

  test('digest precedence over tag when both are supplied', () => {
    const { stack, repo } = makeScope({
      forgeOmniImageDigest: VALID_DIGEST,
      forgeOmniImageTag: 'abc12345',
    });
    // Should not throw; digest path wins.
    expect(() => resolveEcrImage(stack, repo, 'forgeOmni')).not.toThrow();
  });

  test('requireImmutable:false is the only way to fall back to :latest (non-OMNI opt-out)', () => {
    const { stack, repo } = makeScope();
    // Explicit, narrowly-scoped opt-out -- does not throw.
    expect(() =>
      resolveEcrImage(stack, repo, 'forgeApp', { requireImmutable: false }),
    ).not.toThrow();
  });
});
