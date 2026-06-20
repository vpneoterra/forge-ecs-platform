import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * resolveEcrImage — build an ECS container image reference from an existing ECR
 * repository, pinned to an IMMUTABLE, content-addressed identifier.
 *
 * BACKGROUND — why this exists
 * -----------------------------
 * Several Forge task definitions historically referenced their image by the
 * mutable ':latest' tag (e.g. `ContainerImage.fromEcrRepository(repo, 'latest')`).
 * That is fragile in two distinct ways:
 *
 *   1. `fromEcrRepository(repo, 'latest')` resolves ':latest' to an immutable
 *      '@sha256:<digest>' AT SYNTH TIME and bakes it into the CFN template.
 *      When CI later overwrites ':latest' with a new push, the synthesized
 *      task-def is byte-identical (still the OLD digest) — CDK sees no diff,
 *      no new task revision is created, and ECS keeps the stale image. Worse,
 *      once the old digest is GC'd by ECR lifecycle, cold starts fail with
 *      CannotPullContainerError. (This is exactly the forge-fluxtk incident.)
 *
 *   2. Even using a literal floating ':latest' string (via fromRegistry) auto-
 *      pulls current ':latest' on cold start, but a new push does NOT trigger
 *      an ECS rollout because the task-def text is unchanged.
 *
 * RC2-A/RC2-C (program 253f20a6 "Solar Nomad")
 * --------------------------------------------
 * The OMNI scale-out fleet (`omni-dev2`, desired=3) ran runningCount=0 for an
 * entire program window: every task died with
 *   `CannotPullContainerError: pull image manifest has been retried 7 time(s):
 *    failed to resolve ref .../forge-omni-dev2:latest@sha256:72fac36…`
 * because the task def pinned the MUTABLE `:latest` tag and the digest its
 * deployment had pinned was deleted from ECR by the lifecycle policy. A
 * deployment must NEVER depend on what `:latest` happens to resolve to at
 * task-start, so this helper no longer accepts a `:latest` fallback.
 *
 * THE CONTRACT
 * ------------
 * Reference an IMMUTABLE per-build identifier so each push produces a NEW
 * task-def revision and ECS auto-rolls the service. Precedence (highest first):
 *
 *   -c <prefix>ImageDigest=sha256:<hex>   -> pin by digest (strongest; preferred)
 *   -c <prefix>ImageTag=<immutable-tag>   -> pin by immutable build tag
 *                                            (CI pushes git-SHA + timestamp tags)
 *
 * If NEITHER is supplied and `requireImmutable` is true (the default), synth
 * FAILS LOUDLY rather than silently emitting a `:latest` reference. CI must pass
 * `-c <prefix>ImageDigest=$(immutable digest)` (or the git-SHA tag) at
 * `cdk deploy` time so every deploy is pinned and self-rolling.
 *
 * `requireImmutable: false` is an explicit, narrowly-scoped opt-out for repos
 * that genuinely have no build pipeline wired through this helper yet; it falls
 * back to `:latest`. It must never be used for the OMNI render task definitions.
 *
 * @param scope      construct scope (for fromEcrRepository)
 * @param repo       the imported/created ECR repository
 * @param ctxPrefix  context-key prefix, e.g. 'omni' -> reads omniImageDigest / omniImageTag
 * @param opts.requireImmutable  default true; when true, throws if no digest/tag pin is supplied
 */
export function resolveEcrImage(
  scope: Construct,
  repo: ecr.IRepository,
  ctxPrefix: string,
  opts: { requireImmutable?: boolean } = {},
): ecs.EcrImage {
  const requireImmutable = opts.requireImmutable ?? true;
  const digest = scope.node.tryGetContext(`${ctxPrefix}ImageDigest`) as string | undefined;
  const tag = scope.node.tryGetContext(`${ctxPrefix}ImageTag`) as string | undefined;

  // ecs.EcrImage(repo, tagOrDigest): a digest must be passed WITH the 'sha256:'
  // prefix and no leading '@' — CDK inserts the '@' when forming the URI.
  if (digest) {
    const ref = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
    if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
      throw new Error(
        `resolveEcrImage(${ctxPrefix}): -c ${ctxPrefix}ImageDigest must be a full ` +
          `'sha256:<64-hex>' digest, got '${digest}'. Do NOT coerce — pass the exact ` +
          `digest emitted by the build pipeline.`,
      );
    }
    return ecs.ContainerImage.fromEcrRepository(repo, ref);
  }

  if (tag) {
    const t = String(tag);
    if (t === 'latest') {
      throw new Error(
        `resolveEcrImage(${ctxPrefix}): ':latest' is a mutable tag and is forbidden as ` +
          `an image reference (RC2-A/RC2-C). Pass an immutable build-SHA tag or an ` +
          `@sha256 digest via -c ${ctxPrefix}ImageDigest / -c ${ctxPrefix}ImageTag.`,
      );
    }
    return ecs.ContainerImage.fromEcrRepository(repo, t);
  }

  if (requireImmutable) {
    throw new Error(
      `resolveEcrImage(${ctxPrefix}): no immutable image reference supplied. ` +
        `A deployment must pin an exact image so it cannot break when ':latest' is ` +
        `overwritten or its digest is expired from ECR (RC2-A/RC2-C, program 253f20a6). ` +
        `Pass exactly one of:\n` +
        `  -c ${ctxPrefix}ImageDigest=sha256:<64-hex>   (preferred)\n` +
        `  -c ${ctxPrefix}ImageTag=<immutable-build-sha-tag>\n` +
        `CI should pass the digest it just pushed. To deliberately allow a mutable ` +
        `':latest' for a non-OMNI repo with no pinned pipeline, call ` +
        `resolveEcrImage(..., { requireImmutable: false }).`,
    );
  }

  // Explicit, narrowly-scoped opt-out only (never the OMNI render task defs).
  return ecs.ContainerImage.fromEcrRepository(repo, 'latest');
}
