import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');

describe('Shape Check workflow', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/shape-check.yml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'scripts/shape-check.sh'), 'utf8');
  const harnessRun = fs.readFileSync(path.join(root, 'scripts/harness-run.sh'), 'utf8');

  test('is a reusable workflow_dispatch process, not a hard-coded 313 run', () => {
    expect(workflow).toContain('name: Shape Check');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain("Number of shapes to evaluate, or 'all'");
    expect(workflow).toContain('corpus_count=${COUNT}');
    expect(workflow).not.toContain('expected 313');
  });

  test('runs isolated one-shape ECS tasks and preserves artifacts', () => {
    expect(script).toContain('RUN_LIMIT=1');
    expect(script).toContain('SHAPE_START_INDEX="${idx}"');
    expect(script).toContain('shape-check-results.jsonl');
    expect(script).toContain('shape-check-classification.csv');
    expect(script).toContain('shape-check-report.md');
    expect(workflow).toContain('Upload Shape Check artifacts');
  });

  test('classifies usefulness rather than only pass/fail', () => {
    expect(script).toContain('good_renderable');
    expect(script).toContain('good_needs_coarse_or_scale_tier');
    expect(script).toContain('good_complexity_limited');
    expect(script).toContain('renderer_blocker');
    expect(script).toContain('chip_or_api_contract_error');
  });

  test('supports future 1000+ shape corpora with dynamic count override', () => {
    expect(harnessRun).toContain('EXPECTED_SHAPE_CHIP_COUNT');
    expect(workflow).toContain('EXPECTED_SHAPE_CHIP_COUNT: ${{ env.corpus_count }}');
    expect(script).toContain('corpus_count');
  });
});
