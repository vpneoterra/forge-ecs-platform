/**
 * Identity of the EXISTING `omni-backlog-metric` CloudWatch series (RC2-B).
 *
 * BACKGROUND
 * ----------
 * An out-of-band Lambda (`omni-backlog-metric`, deployed outside this CDK repo)
 * publishes the OMNI render backlog to CloudWatch every minute. During program
 * 253f20a6 ("Solar Nomad") it correctly reported `backlog=5, running=0` for ~30
 * minutes. The metric was never the defect — the defect (RC2-B) is that NOTHING
 * CONSUMED it: there was no CloudWatch alarm and no Application Auto Scaling
 * policy on either OMNI service keyed to this series, so a correct backlog signal
 * produced zero added capacity inside the 900 s W6 window.
 *
 * This module is the single, explicit declaration of that metric's identity so
 * the scaling policies in lib/forge-omni-stack.ts and lib/forge-app-stack.ts
 * CONSUME the existing series rather than inventing a new one. The values below
 * MUST match what the `omni-backlog-metric` Lambda publishes. They are NOT a new
 * metric — changing them here does not change what the Lambda emits; it only
 * changes what the scaler reads, so they must stay in lockstep with the Lambda.
 *
 * If the Lambda's published namespace/metric-name/dimension ever changes, update
 * THIS file (and only this file) so every consumer follows.
 */

/** CloudWatch namespace the platform publishes custom metrics under. */
export const OMNI_BACKLOG_NAMESPACE = 'FORGE/Platform';

/**
 * The two series the `omni-backlog-metric` Lambda publishes:
 *   - `backlog`          : count of render jobs queued but not yet claimed.
 *   - `backlog_per_task` : backlog divided by RUNNING render tasks (the
 *                          load-per-task signal a target-tracking policy keys on).
 */
export const OMNI_BACKLOG_METRIC_NAME = 'backlog';
export const OMNI_BACKLOG_PER_TASK_METRIC_NAME = 'backlog_per_task';

/**
 * Dimension key the Lambda tags each datapoint with so the backlog of one render
 * tier (service) can be distinguished from another. The dimension VALUE is the
 * ECS service name (e.g. `omni-dev2`, `forge-omni`), supplied by each consumer.
 */
export const OMNI_BACKLOG_SERVICE_DIMENSION = 'Service';

/**
 * Target backlog-per-task for the target-tracking policy. With a target of 1.0,
 * Application Auto Scaling drives DesiredCount toward `backlog` whenever
 * `running < backlog` (one task per queued job), then scales back in as the
 * backlog drains. Sized so backlog=5/running=0 scales out promptly within W6.
 */
export const OMNI_BACKLOG_PER_TASK_TARGET = 1.0;
