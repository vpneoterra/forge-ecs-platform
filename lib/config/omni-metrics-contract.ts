/**
 * SINGLE SOURCE OF TRUTH for the OMNI/Render metrics-PUBLISHING contract shared
 * by BOTH OMNI render task definitions:
 *   - the GREEN embedded `forge-omni` service in lib/forge-app-stack.ts, and
 *   - the SCALABLE-POOL `omni-<env>` service in lib/forge-omni-stack.ts.
 *
 * WHY THIS FILE EXISTS (RC-1 anti-regression)
 * -------------------------------------------
 * RC-2 (PR #129) wired the PRODUCER of the OMNI/Render backlog series — the
 * in-process RenderMetricsPublisher — onto the GREEN task def only. The
 * scalable-pool task def (forge-omni-stack.ts) wires three backlog-driven
 * autoscaling policies that CONSUME OMNI/Render BacklogPerTask / QueueDepth, but
 * never enabled the producer: `OMNI_METRICS=on` was unset (RenderMetricsPublisher
 * is gated OFF without it — RenderMetricsPublisher.cs:92) AND the task role had no
 * `cloudwatch:PutMetricData` grant (every publish AccessDenies and is swallowed —
 * RenderMetricsPublisher.cs:195). So the pool's scalable target sits on
 * INSUFFICIENT_DATA forever and holds at the floor while backlog > 0. A consumer
 * with no producer passed CI because the RC-2 parity tests only assert the
 * consumer exists.
 *
 * To make that divergence STRUCTURALLY IMPOSSIBLE — exactly as
 * lib/config/omni-mesh-contract.ts does for the FACET2 mesh contract — the env
 * key and the namespace-scoped grant are declared ONCE here and applied by BOTH
 * stacks via `applyOmniRenderMetrics`. A parity test
 * (test/forge-omni-metrics-parity.test.ts) synthesizes both task defs and fails
 * the build if either lacks the producer wiring. The publisher must publish or the
 * deploy is wrong; there is NO swallow path.
 */

import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { OMNI_BACKLOG_NAMESPACE } from './omni-backlog-metric';

/**
 * Env key that gates the in-process RenderMetricsPublisher. Unset ⇒ the publisher
 * is inert and the OMNI/Render series is never emitted (RenderMetricsPublisher.cs:92).
 */
export const OMNI_RENDER_METRICS_ENV_KEY = 'OMNI_METRICS';
export const OMNI_RENDER_METRICS_ENV_VALUE = 'on';

/**
 * Apply the OMNI/Render metrics-publishing contract to an OMNI task definition's
 * omni-api container + task role:
 *   (a) set OMNI_METRICS=on so the RenderMetricsPublisher actually runs, and
 *   (b) attach a `cloudwatch:PutMetricData` grant scoped to the OMNI/Render
 *       namespace.
 *
 * Both OMNI stacks call this with their own (container, taskRole) so green and
 * pool cannot diverge on the producer contract.
 *
 * Least privilege: PutMetricData does NOT support resource-level ARNs, so
 * `Resource` MUST be '*'; the grant is pinned to OMNI/Render ONLY via a
 * `cloudwatch:namespace` StringEquals condition. No widening.
 */
export function applyOmniRenderMetrics(
  scope: cdk.Stack,
  container: ecs.ContainerDefinition,
  taskRole: iam.IRole,
): void {
  container.addEnvironment(
    OMNI_RENDER_METRICS_ENV_KEY,
    OMNI_RENDER_METRICS_ENV_VALUE,
  );

  taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'OmniRenderMetricsPublish',
    effect: iam.Effect.ALLOW,
    actions: ['cloudwatch:PutMetricData'],
    resources: ['*'],
    conditions: {
      StringEquals: { 'cloudwatch:namespace': OMNI_BACKLOG_NAMESPACE },
    },
  }));
}
