/**
 * Identity of the AUTHORITATIVE OMNI render-backlog CloudWatch series (RC-2).
 *
 * BACKGROUND
 * ----------
 * The OMNI render fleet was scaled off a backlog series published by an
 * out-of-band Lambda (`omni-backlog-metric`, deployed outside this CDK repo)
 * under namespace `FORGE/Platform`. That Lambda computed its backlog from the
 * Supabase MIRROR table `bom_omni_render_jobs` counting `status='submitted'` —
 * a column the live render workers never write (they own the durable
 * `omni.render_jobs` queue with states queued/running/completed/failed). The
 * mirror therefore reported a CONSTANT backlog (0 / a frozen value), so the
 * target-tracking policies keyed to it never saw real queue pressure: a dead
 * scaling signal (RC-2).
 *
 * THE FIX (RC-2)
 * --------------
 * The render workers' RenderMetricsPublisher (forgenew
 * docker/omni/src/Services/RenderMetricsPublisher.cs) now publishes the backlog
 * from authoritative `omni.render_jobs` ground truth to namespace `OMNI/Render`,
 * dimensioned by `ServiceName`:
 *   - `QueueDepth`     : COUNT(*) FILTER (status='queued')   — genuinely pending.
 *   - `BacklogPerTask` : (queued + running) / running-task-count (floored at 1),
 *                        the load-per-task signal the target-tracking policy keys
 *                        on. Floor of 1 makes a backlog with zero running tasks
 *                        read as MAX pressure (the 0->1 scale-from-zero lift).
 *
 * This module is the single, explicit declaration of that metric's identity so
 * the scaling policies in lib/forge-app-stack.ts (and the forgenew terraform
 * autoscaler) CONSUME the SAME authoritative series the workers actually emit,
 * keyed to the canonical service dimension. These values MUST match what
 * RenderMetricsPublisher publishes; if the publisher's namespace/metric-name/
 * dimension ever changes, update THIS file (and only this file) so every
 * consumer follows.
 */

/** CloudWatch namespace the OMNI render workers publish ground-truth metrics under. */
export const OMNI_BACKLOG_NAMESPACE = 'OMNI/Render';

/**
 * The two series RenderMetricsPublisher emits that drive backlog scaling:
 *   - `QueueDepth`     : count of render jobs queued (status='queued') in
 *                        omni.render_jobs — genuinely pending, not yet claimed.
 *   - `BacklogPerTask` : (queued + running) / running task count (floored at 1) —
 *                        the load-per-task signal a target-tracking policy keys on.
 */
export const OMNI_BACKLOG_METRIC_NAME = 'QueueDepth';
export const OMNI_BACKLOG_PER_TASK_METRIC_NAME = 'BacklogPerTask';

/**
 * Dimension key the publisher tags each datapoint with so the backlog of one
 * render service can be distinguished from another. The dimension VALUE is the
 * ECS service name (the canonical `forge-omni`), supplied by each consumer.
 * Matches `new Dimension { Name = "ServiceName", ... }` in RenderMetricsPublisher.
 */
export const OMNI_BACKLOG_SERVICE_DIMENSION = 'ServiceName';

/**
 * Target backlog-per-task for the target-tracking policy. With a target of 1.0,
 * Application Auto Scaling holds roughly one outstanding render per running task,
 * driving DesiredCount toward the real backlog and scaling back in as it drains.
 */
export const OMNI_BACKLOG_PER_TASK_TARGET = 1.0;
