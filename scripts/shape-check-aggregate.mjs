#!/usr/bin/env node
/**
 * Aggregate chunked Shape Check artifacts.
 *
 * The chunked workflow runs bounded windows so every GitHub-hosted runner job
 * stays below the 6-hour limit. This script merges those windows back into the
 * canonical artifact shape consumed by sync-shape-check-to-axiom.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/shape-check-aggregate.mjs \\
    --input downloaded-shape-check-artifacts \\
    --out shape-check-artifacts \\
    --corpus-count 1000 \\
    --start-index 0 \\
    --limit 1000
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  return out;
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`);
      }
    });
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  for (const key of ['input', 'out', 'corpus-count', 'start-index', 'limit']) {
    if (!args[key]) {
      usage();
      throw new Error(`Missing required --${key}`);
    }
  }

  const inputDir = path.resolve(args.input);
  const outDir = path.resolve(args.out);
  const corpusCount = Number(args['corpus-count']);
  const startIndex = Number(args['start-index']);
  const limit = Number(args.limit);
  if (!Number.isInteger(corpusCount) || corpusCount < 1) throw new Error('--corpus-count must be a positive integer');
  if (!Number.isInteger(startIndex) || startIndex < 0) throw new Error('--start-index must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const endExclusive = startIndex + limit;
  if (endExclusive > corpusCount) throw new Error(`Requested window ${startIndex}..${endExclusive - 1} exceeds corpus_count=${corpusCount}`);

  ensureDir(outDir);
  ensureDir(path.join(outDir, 'per-shape-logs'));
  ensureDir(path.join(outDir, 'diagnostics'));
  ensureDir(path.join(outDir, 'chunks'));

  const files = walkFiles(inputDir);
  const resultFiles = files.filter((file) => path.basename(file) === 'shape-check-results.jsonl');
  const manifestFiles = files.filter((file) => path.basename(file) === 'shape-manifest.jsonl');
  const metadataFiles = files.filter((file) => path.basename(file) === 'shape-check-run-metadata.json');
  const chunkSummaries = files
    .filter((file) => path.basename(file) === 'shape-check-summary.json')
    .map((file) => ({ file, summary: readJsonIfExists(file) }))
    .filter((item) => item.summary);

  const rowsByIndex = new Map();
  for (const file of resultFiles) {
    for (const row of readJsonl(file)) {
      const idx = Number(row.shape_index);
      if (!Number.isInteger(idx)) continue;
      rowsByIndex.set(idx, row);
    }
  }
  const rows = [...rowsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);

  let manifestRows = [];
  if (manifestFiles.length) {
    const candidates = manifestFiles.map((file) => ({ file, rows: readJsonl(file) }));
    candidates.sort((a, b) => b.rows.length - a.rows.length);
    manifestRows = candidates[0].rows;
  }

  for (const artifactDir of fs.existsSync(inputDir) ? fs.readdirSync(inputDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
    const artifactName = artifactDir.name;
    const root = path.join(inputDir, artifactName);
    copyDir(path.join(root, 'per-shape-logs'), path.join(outDir, 'per-shape-logs', artifactName));
    copyDir(path.join(root, 'diagnostics'), path.join(outDir, 'diagnostics', artifactName));
    copyDir(root, path.join(outDir, 'chunks', artifactName));
  }

  const expected = [];
  for (let idx = startIndex; idx < endExclusive; idx += 1) expected.push(idx);
  const missingIndices = expected.filter((idx) => !rowsByIndex.has(idx));
  const extraIndices = rows
    .map((row) => Number(row.shape_index))
    .filter((idx) => idx < startIndex || idx >= endExclusive);

  fs.writeFileSync(
    path.join(outDir, 'shape-check-results.jsonl'),
    rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).join('\n') + (rows.length ? '\n' : ''),
  );
  if (manifestRows.length) {
    fs.writeFileSync(
      path.join(outDir, 'shape-manifest.jsonl'),
      manifestRows.map((row) => JSON.stringify(row, Object.keys(row).sort())).join('\n') + '\n',
    );
  }

  const classificationCounts = countBy(rows, (row) => row.shape_check_classification);
  const failureTypeCounts = countBy(rows, (row) => row.failure_type || (row.ok ? 'ok' : 'unknown'));
  const firstRendererBlocker = rows.find((row) => row.shape_check_classification === 'renderer_blocker') || null;
  const summary = {
    corpus_count: corpusCount,
    start_index: startIndex,
    limit,
    end_exclusive: endExclusive,
    expected_evaluated: limit,
    evaluated: rows.length,
    ok: rows.filter((row) => row.ok === true || row.ok === 'true').length,
    failed: rows.filter((row) => !(row.ok === true || row.ok === 'true')).length,
    complete: missingIndices.length === 0 && extraIndices.length === 0,
    missing_indices: missingIndices,
    extra_indices: extraIndices,
    chunk_artifact_count: new Set(resultFiles.map((file) => path.basename(path.dirname(file)))).size,
    chunk_summary_count: chunkSummaries.length,
    classification_counts: classificationCounts,
    failure_type_counts: failureTypeCounts,
    first_renderer_blocker: firstRendererBlocker
      ? {
          shape_index: firstRendererBlocker.shape_index,
          name: firstRendererBlocker.name,
          failure_type: firstRendererBlocker.failure_type,
          error: firstRendererBlocker.error,
        }
      : null,
  };
  fs.writeFileSync(path.join(outDir, 'shape-check-summary.json'), stableJson(summary));
  fs.writeFileSync(path.join(outDir, 'shape-check-aggregate-summary.json'), stableJson({
    ...summary,
    chunk_summaries: chunkSummaries.map((item) => ({
      artifact: path.basename(path.dirname(item.file)),
      file: path.relative(inputDir, item.file),
      summary: item.summary,
    })),
    chunk_metadata: metadataFiles.map((file) => ({
      artifact: path.basename(path.dirname(file)),
      file: path.relative(inputDir, file),
      metadata: readJsonIfExists(file),
    })),
  }));

  const headers = [
    'shape_index',
    'name',
    'chip_id',
    'source_path',
    'ok',
    'failure_type',
    'classification',
    'recommendation',
    'suggested_min_voxel_size_mm',
    'voxel_size_mm',
    'elapsed_ms',
    'omni_health_after',
    'error',
  ];
  const csvRows = [headers.join(',')];
  for (const row of rows) {
    csvRows.push([
      row.shape_index,
      row.name,
      row.chip_id,
      row.source_path,
      row.ok,
      row.failure_type,
      row.shape_check_classification,
      row.shape_check_recommendation,
      row.suggested_min_voxel_size_mm,
      row.voxel_size_mm,
      row.elapsed_ms,
      row.omni_health_after,
      String(row.error || '').slice(0, 1000),
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(outDir, 'shape-check-classification.csv'), `${csvRows.join('\n')}\n`);

  const report = [
    '# Shape Check Report',
    '',
    fline('Corpus count', summary.corpus_count),
    fline('Requested window', `${summary.start_index}..${summary.end_exclusive - 1}`),
    fline('Expected evaluated', summary.expected_evaluated),
    fline('Evaluated', summary.evaluated),
    fline('Complete', summary.complete),
    fline('Good renderable', classificationCounts.good_renderable || 0),
    fline('Needs coarse/scale tier', classificationCounts.good_needs_coarse_or_scale_tier || 0),
    fline('Complexity limited', classificationCounts.good_complexity_limited || 0),
    fline('Renderer blockers', classificationCounts.renderer_blocker || 0),
    fline('Chip/API errors', classificationCounts.chip_or_api_contract_error || 0),
    '',
    '## Classification counts',
    '',
    ...Object.entries(classificationCounts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Failure type counts',
    '',
    ...Object.entries(failureTypeCounts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Completeness',
    '',
    `- Missing indices: ${missingIndices.length ? missingIndices.join(', ') : 'none'}`,
    `- Extra indices: ${extraIndices.length ? extraIndices.join(', ') : 'none'}`,
    '',
    '## Files',
    '',
    '- shape-check-results.jsonl: merged isolated per-shape records',
    '- shape-check-classification.csv: spreadsheet-friendly keep/fix/quarantine decisions',
    '- shape-check-aggregate-summary.json: chunk-level aggregation diagnostics',
    '- per-shape-logs/: chunked harness logs',
    '- diagnostics/: ECS service/stopped-task snapshots for renderer blockers',
  ];
  if (summary.first_renderer_blocker) {
    report.splice(report.indexOf('## Completeness'), 0,
      '',
      '## First renderer blocker',
      '',
      `- Shape index: ${summary.first_renderer_blocker.shape_index}`,
      `- Name: ${summary.first_renderer_blocker.name}`,
      `- Failure type: ${summary.first_renderer_blocker.failure_type}`,
      `- Error: ${String(summary.first_renderer_blocker.error || '').slice(0, 500)}`,
      '',
    );
  }
  fs.writeFileSync(path.join(outDir, 'shape-check-report.md'), `${report.join('\n')}\n`);

  console.log(stableJson(summary));
}

function fline(label, value) {
  return `- ${label}: ${value}`;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
