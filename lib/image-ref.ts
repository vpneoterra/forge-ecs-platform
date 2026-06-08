import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * resolveEcrImage — build an ECS container image reference from an existing ECR
 * repository, with an opt-in immutable pin sourced from CDK context.
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
 * THE FIX
 * -------
 * Reference an IMMUTABLE per-build identifier so each push produces a NEW
 * task-def revision and ECS auto-rolls the service. Precedence (highest first):
 *
 *   -c <prefix>ImageDigest=sha256:<hex>   -> pin by digest (strongest; preferred)
 *   -c <prefix>ImageTag=<immutable-tag>   -> pin by immutable build tag
 *                                            (CI already pushes git-SHA + timestamp tags)
 *   (neither provided)                    -> fall back to ':latest' for backwards
 *                                            compatibility. Callers must then run
 *                                            `aws ecs update-service --force-new-deployment`
 *                                            after a push to roll the container.
 *
 * Recommended: have CI pass `-c <prefix>ImageDigest=$(immutable digest)` (or the
 * git-SHA tag) at `cdk deploy` time so deploys are always pinned and self-rolling.
 *
 * @param scope      construct scope (for fromEcrRepository)
 * @param repo       the imported/created ECR repository
 * @param ctxPrefix  context-key prefix, e.g. 'omni' -> reads omniImageDigest / omniImageTag
 */
export function resolveEcrImage(
  scope: Construct,
  repo: ecr.IRepository,
  ctxPrefix: string,
): ecs.EcrImage {
  const digest = scope.node.tryGetContext(`${ctxPrefix}ImageDigest`) as string | undefined;
  const tag = scope.node.tryGetContext(`${ctxPrefix}ImageTag`) as string | undefined;

  // ecs.EcrImage(repo, tagOrDigest): a digest must be passed WITH the 'sha256:'
  // prefix and no leading '@' — CDK inserts the '@' when forming the URI.
  let ref: string;
  if (digest) {
    ref = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
  } else if (tag) {
    ref = String(tag);
  } else {
    ref = 'latest';
  }

  return ecs.ContainerImage.fromEcrRepository(repo, ref);
}
