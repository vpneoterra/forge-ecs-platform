/**
 * Tests for the tier-2 testing harness manifest.
 */
import {
  SHAPE_CHIP_EXPECTED_COUNT,
  SHAPE_CHIP_PACKS,
  HARNESS_RUNNER,
  HARNESS_COST_CEILING_USD,
  HARNESS_BUDGET_THRESHOLDS_PERCENT,
  HARNESS_COST_CENTER_TAG,
} from '../lib/config/testing-harness-manifest';

describe('testing-harness-manifest', () => {
  test('expects 313 shape chips', () => {
    expect(SHAPE_CHIP_EXPECTED_COUNT).toBe(313);
  });

  test('13 shape packs match the forgenew pack layout', () => {
    expect(SHAPE_CHIP_PACKS).toHaveLength(13);
    expect(SHAPE_CHIP_PACKS).toContain('robotics');
    expect(SHAPE_CHIP_PACKS).toContain('aerospace');
  });

  test('runner uses the confirmed OMNI render path', () => {
    expect(HARNESS_RUNNER.omniRenderPath).toBe('/api/sdf/render');
    expect(HARNESS_RUNNER.omniHealthPath).toBe('/api/health');
  });

  test('cost ceiling is USD 50', () => {
    expect(HARNESS_COST_CEILING_USD).toBe(50);
  });

  test('budget thresholds are sane and strictly increasing', () => {
    for (let i = 1; i < HARNESS_BUDGET_THRESHOLDS_PERCENT.length; i++) {
      expect(HARNESS_BUDGET_THRESHOLDS_PERCENT[i]).toBeGreaterThan(
        HARNESS_BUDGET_THRESHOLDS_PERCENT[i - 1],
      );
    }
    expect(HARNESS_BUDGET_THRESHOLDS_PERCENT[0]).toBeGreaterThanOrEqual(1);
    expect(HARNESS_BUDGET_THRESHOLDS_PERCENT.slice(-1)[0]).toBeLessThanOrEqual(100);
  });

  test('cost-center tag is scoped to harness', () => {
    expect(HARNESS_COST_CENTER_TAG.key).toBe('CostCenter');
    expect(HARNESS_COST_CENTER_TAG.value).toBe('forge-testing-harness');
  });

  test('maxPartsPerRun defaults to the expected chip count', () => {
    expect(HARNESS_RUNNER.maxPartsPerRun).toBe(SHAPE_CHIP_EXPECTED_COUNT);
  });
});
