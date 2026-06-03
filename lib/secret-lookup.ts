/**
 * secret-lookup.ts -- Resolve Secrets Manager full ARNs at deploy time.
 *
 * Background
 * ----------
 * CDK's `secretsmanager.Secret.fromSecretNameV2(...)` returns an ISecret whose
 * `.secretArn` is the *name-only* ARN form, e.g.
 *   arn:aws:secretsmanager:us-east-1:123:secret:forge/test/supabase-jwt-secret
 *
 * That form is accepted by IAM policies (with implicit wildcard) and by
 * `DescribeSecret`, but `ecs.Secret.fromSecretsManager(importedByName)` uses
 * `.secretArn` verbatim as the task definition's `valueFrom`, and the ECS
 * agent's runtime call to `GetSecretValue` can fail with
 * `ResourceNotFoundException` when the name-only form collides with partial-ARN
 * matching heuristics or caches.
 *
 * The deterministic cure is to feed ECS a *complete* ARN, including the
 * Secrets Manager-generated six-character suffix. We don't know those suffixes
 * at synth time, so we look them up at deploy time via an AwsCustomResource
 * that calls `secretsmanager:DescribeSecret` and exposes the returned `ARN`.
 * We then wrap that in `Secret.fromSecretCompleteArn(...)` so downstream
 * `ecs.Secret.fromSecretsManager(...)` embeds the suffixed ARN.
 *
 * One Lambda-backed custom resource is provisioned per unique secret per
 * stack. This is cheap -- provider Lambdas are shared, and the resource only
 * runs on create/update of the stack.
 */

import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';

/**
 * Resolve the full ARN (with 6-char suffix) of an existing Secrets Manager
 * secret by its bare name. The lookup runs at deploy time via a custom
 * resource, so the returned string is a CloudFormation token that CDK
 * resolves during stack operations.
 *
 * The returned ISecret is safe to pass to `ecs.Secret.fromSecretsManager(...)`.
 * Use `grantRead(role)` on it to scope the execution role's
 * `secretsmanager:GetSecretValue` permission correctly.
 */
export function importSecretByName(
  scope: Construct,
  id: string,
  secretName: string,
): secretsmanager.ISecret {
  const lookup = new AwsCustomResource(scope, `${id}Lookup`, {
    onCreate: {
      service: 'SecretsManager',
      action: 'describeSecret',
      parameters: { SecretId: secretName },
      physicalResourceId: PhysicalResourceId.of(`${secretName}-arn-lookup`),
    },
    onUpdate: {
      service: 'SecretsManager',
      action: 'describeSecret',
      parameters: { SecretId: secretName },
      physicalResourceId: PhysicalResourceId.of(`${secretName}-arn-lookup`),
    },
    // DescribeSecret requires the partial ARN in the resource policy. We use
    // a wildcard on the suffix so the IAM check passes regardless of the
    // secret's current suffix.
    policy: AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret'],
        resources: [`arn:aws:secretsmanager:*:*:secret:${secretName}-*`],
      }),
    ]),
    installLatestAwsSdk: false,
  });

  const fullArn = lookup.getResponseField('ARN');

  return secretsmanager.Secret.fromSecretCompleteArn(scope, id, fullArn);
}

/**
 * Convenience: import a secret by name AND return it wrapped as an
 * `ecs.Secret` ready to be plugged into a container's `secrets` map.
 *
 * Equivalent to:
 *   const s = importSecretByName(scope, id, name);
 *   return ecs.Secret.fromSecretsManager(s);
 */
export function ecsSecretByName(
  scope: Construct,
  id: string,
  secretName: string,
): ecs.Secret {
  return ecs.Secret.fromSecretsManager(
    importSecretByName(scope, id, secretName),
  );
}
