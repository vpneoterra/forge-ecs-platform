#!/usr/bin/env node
/**
 * Sync Shape Check results into AXIOM shape-chip metadata.
 *
 * This script intentionally writes a compact latest-status summary into each
 * chip and leaves the full evidence in GitHub/AWS artifacts. The shape payload
 * remains the canonical archetype definition; validation state lives in
 * root-level `shape_check`, `telemetry.render_metrics`, and `weaknesses`.
 */
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/sync-shape-check-to-axiom.mjs \\
    --results shape-check-artifacts/shape-check-results.jsonl \\
    --chips-root forgenew-src/server/axiom/chips/shapes \\
    --run-id 24742193274 \\
    --workflow-url https://github.com/vpneoterra/forge-ecs-platform/actions/runs/24742193274 \\
    --checked-at 2026-04-21T20:19:36Z \\
    --environment dev
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
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

function walkJsonFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(full);
    }
  }
  return files.sort();
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOk(value) {
  return value === true || value === 'true' || value === 'True';
}

function uniqueStrings(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))];
}

function classificationMeta(classification, failureType, ok) {
  if (ok) {
    return {
      renderability: 'renderable',
      usefulness: 'keep',
      tier: 'default_preview',
      quarantine: false,
      weaknessSeverity: 'none',
      weaknessType: null,
    };
  }
  if (classification === 'good_needs_coarse_or_scale_tier') {
    return {
      renderability: 'coarse_preview_required',
      usefulness: 'keep',
      tier: 'coarse_preview_or_stress',
      quarantine: false,
      weaknessSeverity: 'low',
      weaknessType: 'coarse_preview_required',
    };
  }
  if (classification === 'good_complexity_limited') {
    return {
      renderability: 'complexity_limited',
      usefulness: 'keep',
      tier: 'complexity_limited_preview',
      quarantine: true,
      weaknessSeverity: 'medium',
      weaknessType: 'complexity_guard_required',
    };
  }
  if (classification === 'renderer_blocker' || failureType === 'http_5xx' || failureType === 'transport_timeout') {
    return {
      renderability: 'renderer_blocker',
      usefulness: 'unknown_until_renderer_guarded',
      tier: 'quarantined',
      quarantine: true,
      weaknessSeverity: 'high',
      weaknessType: 'renderer_blocker',
    };
  }
  if (classification === 'chip_or_api_contract_error') {
    return {
      renderability: 'api_contract_error',
      usefulness: 'needs_chip_or_mapping_fix',
      tier: 'quarantined',
      quarantine: true,
      weaknessSeverity: 'medium',
      weaknessType: 'chip_or_api_contract_error',
    };
  }
  return {
    renderability: 'needs_triage',
    usefulness: 'needs_triage',
    tier: 'triage',
    quarantine: true,
    weaknessSeverity: 'medium',
    weaknessType: 'shape_check_triage_required',
  };
}

function defaultRecommendation(ok, classification, failureType) {
  if (ok) return 'keep';
  if (classification === 'good_needs_coarse_or_scale_tier') return 'keep_for_coarse_preview_or_stress_tier';
  if (classification === 'good_complexity_limited') return 'keep_but_quarantine_from_default_render';
  if (classification === 'renderer_blocker' || failureType === 'http_5xx') return 'quarantine_and_add_renderer_guard';
  if (classification === 'chip_or_api_contract_error') return 'inspect_chip_payload_or_api_mapping';
  return 'inspect_shape_and_router_mapping';
}

function updateRenderMetrics(chip, result, ok, failureType) {
  chip.telemetry ??= {};
  chip.telemetry.window ??= { period_days: 30, first_sample: null, last_sample: null };
  chip.telemetry.render_metrics ??= {};
  const metrics = chip.telemetry.render_metrics;
  metrics.tessellation_attempts = Number(metrics.tessellation_attempts || 0) + 1;
  metrics.tessellation_successes = Number(metrics.tessellation_successes || 0) + (ok ? 1 : 0);
  metrics.tessellation_failures = Number(metrics.tessellation_failures || 0) + (ok ? 0 : 1);
  metrics.failure_modes = uniqueStrings([...(Array.isArray(metrics.failure_modes) ? metrics.failure_modes : []), ok ? null : failureType]);
  const elapsed = asNumber(result.elapsed_ms);
  const voxel = asNumber(result.voxel_size_mm);
  if (elapsed !== null) {
    metrics.median_render_time_ms ??= elapsed;
    metrics.p95_render_time_ms = Math.max(Number(metrics.p95_render_time_ms || 0), elapsed);
  }
  if (voxel !== null) {
    metrics.median_voxel_size_mm ??= voxel;
  }
}

function updateWeaknesses(chip, result, checkedAt, meta) {
  chip.weaknesses ??= { detected_at: null, severity: 'none', items: [] };
  const current = Array.isArray(chip.weaknesses.items) ? chip.weaknesses.items : [];
  const nonShapeCheck = current.filter((item) => item?.source !== 'shape_check');
  if (meta.weaknessSeverity === 'none') {
    chip.weaknesses.items = nonShapeCheck;
    chip.weaknesses.severity = nonShapeCheck.length ? chip.weaknesses.severity : 'none';
    chip.weaknesses.detected_at = nonShapeCheck.length ? chip.weaknesses.detected_at : null;
    return;
  }
  chip.weaknesses.detected_at = checkedAt;
  chip.weaknesses.severity = meta.weaknessSeverity;
  chip.weaknesses.items = [
    ...nonShapeCheck,
    {
      type: meta.weaknessType,
      source: 'shape_check',
      detected_at: checkedAt,
      run_id: String(result.shape_check_run_id),
      failure_type: result.failure_type || null,
      description: result.error
        ? String(result.error).slice(0, 500)
        : `Shape Check classified this chip as ${result.shape_check_classification}.`,
      recommendation: result.shape_check_recommendation || defaultRecommendation(false, result.shape_check_classification, result.failure_type),
    },
  ];
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const required = ['results', 'chips-root', 'run-id', 'workflow-url', 'checked-at', 'environment'];
  for (const key of required) {
    if (!args[key]) {
      usage();
      throw new Error(`Missing required --${key}`);
    }
  }

  const resultsPath = path.resolve(args.results);
  const chipsRoot = path.resolve(args['chips-root']);
  const checkedAt = args['checked-at'];
  const runId = String(args['run-id']);
  const workflowUrl = args['workflow-url'];
  const environment = args.environment;

  if (!fs.existsSync(resultsPath)) throw new Error(`Results file not found: ${resultsPath}`);
  if (!fs.existsSync(chipsRoot)) throw new Error(`Chips root not found: ${chipsRoot}`);

  const chipIndex = new Map();
  for (const file of walkJsonFiles(chipsRoot)) {
    const chip = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (chip.chip_id) chipIndex.set(chip.chip_id, file);
  }

  const results = readJsonl(resultsPath);
  const patched = [];
  const missing = [];
  for (const rawResult of results) {
    const chipId = rawResult.chip_id;
    if (!chipId || !chipIndex.has(chipId)) {
      missing.push({ chip_id: chipId || null, shape_index: rawResult.shape_index ?? null, name: rawResult.name ?? null });
      continue;
    }
    const file = chipIndex.get(chipId);
    const chip = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = boolOk(rawResult.ok);
    const failureType = rawResult.failure_type || (ok ? null : 'unknown');
    const classification = rawResult.shape_check_classification || rawResult.classification || (ok ? 'good_renderable' : 'needs_triage');
    const recommendation = rawResult.shape_check_recommendation || rawResult.recommendation || defaultRecommendation(ok, classification, failureType);
    const meta = classificationMeta(classification, failureType, ok);
    const result = {
      ...rawResult,
      ok,
      failure_type: failureType,
      shape_check_classification: classification,
      shape_check_recommendation: recommendation,
      shape_check_run_id: runId,
    };

    chip.shape_check = {
      schema_version: '1.0.0',
      process: 'shape_check',
      status: classification,
      recommendation,
      last_checked_at: checkedAt,
      last_run_id: runId,
      last_workflow_url: workflowUrl,
      environment,
      shape_index: asNumber(rawResult.shape_index),
      source_path: rawResult.source_path || null,
      omni: {
        status: ok ? 'passed' : 'failed',
        failure_type: ok ? null : failureType,
        error: rawResult.error ? String(rawResult.error).slice(0, 1000) : null,
        voxel_size_mm: asNumber(rawResult.voxel_size_mm),
        suggested_min_voxel_size_mm: asNumber(rawResult.suggested_min_voxel_size_mm),
        elapsed_ms: asNumber(rawResult.elapsed_ms),
        health_after: rawResult.omni_health_after || null,
      },
      classification: {
        renderability: meta.renderability,
        usefulness: meta.usefulness,
        tier: meta.tier,
        quarantine: meta.quarantine,
      },
    };

    chip.telemetry ??= {};
    chip.telemetry.window ??= { period_days: 30, first_sample: null, last_sample: null };
    chip.telemetry.window.first_sample ??= checkedAt;
    chip.telemetry.window.last_sample = checkedAt;
    updateRenderMetrics(chip, result, ok, failureType);
    updateWeaknesses(chip, result, checkedAt, meta);

    fs.writeFileSync(file, stableStringify(chip));
    patched.push({
      chip_id: chipId,
      shape_index: rawResult.shape_index ?? null,
      name: rawResult.name ?? chip.payload?.name ?? null,
      status: classification,
      recommendation,
      file: path.relative(chipsRoot, file),
    });
  }

  const summary = {
    run_id: runId,
    workflow_url: workflowUrl,
    checked_at: checkedAt,
    environment,
    results: results.length,
    patched: patched.length,
    missing: missing.length,
    missing_results: missing,
    patched_results: patched,
  };
  const summaryPath = args['summary-out'] ? path.resolve(args['summary-out']) : path.resolve('shape-check-axiom-sync-summary.json');
  fs.writeFileSync(summaryPath, stableStringify(summary));
  console.log(stableStringify(summary));
  if (missing.length) {
    process.exitCode = 3;
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
