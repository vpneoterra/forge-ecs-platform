/**
 * Shared test fixtures for the OMNI immutable-image-pin contract (RC2-A/RC2-C).
 *
 * The OMNI task definitions (omni-api in both ForgeAppStack's embedded forge-omni
 * service and the standalone ForgeOmniStack) reference their container image by an
 * IMMUTABLE @sha256 digest -- never ':latest' -- via CDK context. `resolveEcrImage`
 * throws at synth time if no digest/tag pin is supplied. That is intentional: a
 * deploy MUST pin an exact image. Tests therefore synth the same way CI deploys,
 * by passing a real-shaped `sha256:<64-hex>` digest in App context.
 *
 * This is NOT a stub or a fabricated value standing in for missing logic -- it is
 * the deploy-time input the helper is designed to require. CI passes the digest it
 * just pushed; tests pass a fixed, valid-format digest so synth succeeds and the
 * no-':latest' regression assertions can run against the generated template.
 */

/** A syntactically valid (format-correct) image digest for synth-time pinning. */
export const TEST_IMAGE_DIGEST =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';

/**
 * App-context map pinning every OMNI image reference to TEST_IMAGE_DIGEST.
 * Keys mirror the `${ctxPrefix}ImageDigest` convention in lib/image-ref.ts:
 *   - 'omni'      -> standalone ForgeOmniStack (lib/forge-omni-stack.ts)
 *   - 'forgeOmni' -> embedded forge-omni service (lib/forge-app-stack.ts)
 */
export const OMNI_IMAGE_PIN_CONTEXT: Record<string, string> = {
  omniImageDigest: TEST_IMAGE_DIGEST,
  forgeOmniImageDigest: TEST_IMAGE_DIGEST,
};
