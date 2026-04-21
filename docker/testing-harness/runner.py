#!/usr/bin/env python3
"""
FORGE Tier-2 Testing Harness Runner
===================================

Drives the 313 OMNI shape-chip JSONs from vpneoterra/forgenew through the
OMNI tessellation/render endpoint and records per-chip pass/fail.

Strict scope:
  * Tier-2 only: shape chip -> OMNI /api/sdf/render
  * No classifier-eval, no Anthropic/Voyage secrets, no tier-3 param sweep.

Corpus source:
  vpneoterra/forgenew @ server/axiom/chips/shapes/<pack>/<name>.json

OMNI endpoint source of truth (forgenew @ 2026-04-21):
  docker/omni/src/Api/SdfRenderEndpoint.cs
    POST /api/sdf/render
    payload: {"part": <BomPartJson>, "voxel_size_mm": float, "output_path": str}

If OMNI's render route ever moves, override via the OMNI_RENDER_PATH env
var -- no code change needed.

Exit codes:
  0  all chips succeeded
  2  count guardrail failed (did not find expected chip count)
  3  OMNI health probe failed
  4  one or more chips failed to render
  5  configuration error (e.g. missing OMNI_BASE_URL)
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import time
import typing as t

import requests


# ── Config loaded from env (mirrors CDK task-def injections) ─────────────
EXPECTED_COUNT        = int(os.environ.get("EXPECTED_SHAPE_CHIP_COUNT", "313"))
MAX_PARTS_PER_RUN     = int(os.environ.get("MAX_PARTS_PER_RUN", str(EXPECTED_COUNT)))
SHAPE_START_INDEX     = int(os.environ.get("SHAPE_START_INDEX", "0"))
STOP_ON_FAILURE       = os.environ.get("STOP_ON_FAILURE", "false").lower() in ("1", "true", "yes")
OMNI_BASE_URL         = os.environ.get("OMNI_BASE_URL", "").rstrip("/")
OMNI_RENDER_PATH      = os.environ.get("OMNI_RENDER_PATH", "/api/sdf/render")
OMNI_HEALTH_PATH      = os.environ.get("OMNI_HEALTH_PATH", "/api/health")
PER_PART_TIMEOUT_SEC  = int(os.environ.get("PER_PART_TIMEOUT_SEC", "120"))
DEFAULT_VOXEL_SIZE_MM = float(os.environ.get("DEFAULT_VOXEL_SIZE_MM", "0.5"))

# Adaptive voxel sizing: when OMNI returns voxel_budget_exceeded with a
# suggested minimum voxel size, the runner retries once with that suggestion
# scaled by VOXEL_SIZE_SAFETY_MULT and capped at MAX_VOXEL_SIZE_MM. OMNI's
# first suggestion can still be conservative after recalculating the actual
# build envelope, so the default multiplier intentionally leaves a wider
# margin while keeping one retry per chip.
# the 1-3 chip smoke executable against live OMNI without blanket-relaxing the
# default voxel size for parts that fit the budget. Set VOXEL_BUDGET_RETRY=0
# to disable and surface voxel_budget_exceeded as a genuine render failure.
VOXEL_BUDGET_RETRY    = os.environ.get("VOXEL_BUDGET_RETRY", "true").lower() in ("1", "true", "yes")
VOXEL_SIZE_SAFETY_MULT = float(os.environ.get("VOXEL_SIZE_SAFETY_MULT", "1.60"))
MAX_VOXEL_SIZE_MM     = float(os.environ.get("MAX_VOXEL_SIZE_MM", "5.0"))

SHAPE_CORPUS_DIR      = pathlib.Path(os.environ.get("SHAPE_CORPUS_DIR", "/corpus/shapes"))
FORGENEW_REPO         = os.environ.get("FORGENEW_REPO", "https://github.com/vpneoterra/forgenew.git")
FORGENEW_SUBPATH      = os.environ.get("FORGENEW_SUBPATH", "server/axiom/chips/shapes")
# ECS tasks must not hold GitHub credentials, so runtime cloning is off
# by default. Set ALLOW_RUNTIME_CLONE=true + a public/anonymous-readable
# FORGENEW_REPO to re-enable the old fallback path.
ALLOW_RUNTIME_CLONE   = os.environ.get("ALLOW_RUNTIME_CLONE", "false").lower() in ("1", "true", "yes")
OUTPUT_DIR            = pathlib.Path(os.environ.get("OUTPUT_DIR", "/tmp/harness-output"))
RESULT_LOG_PREFIX     = os.environ.get("RESULT_LOG_PREFIX", "HARNESS_RESULT_JSON")
SUMMARY_LOG_PREFIX    = os.environ.get("SUMMARY_LOG_PREFIX", "HARNESS_SUMMARY_JSON")

OMNI_API_KEY          = os.environ.get("OMNI_API_KEY")  # optional


# ── Helpers ───────────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    print(f"[harness] {msg}", flush=True)


def _log_structured(prefix: str, payload: dict) -> None:
    print(f"[harness] {prefix} {json.dumps(payload, sort_keys=True)}", flush=True)


def _count_json(root: pathlib.Path) -> int:
    return sum(1 for _ in root.rglob("*.json"))


def ensure_corpus() -> pathlib.Path:
    """Return the path to the shape-chip corpus.

    Resolution order (fail-closed to avoid runtime GitHub creds):
      1. SHAPE_CORPUS_DIR (default /corpus/shapes) baked into the image
         or mounted in by the task definition.
      2. If ALLOW_RUNTIME_CLONE=true, attempt an anonymous depth-1 clone
         of FORGENEW_REPO. This branch is disabled by default because
         vpneoterra/forgenew is private and ECS tasks must not carry a
         GitHub token.
    """
    if SHAPE_CORPUS_DIR.is_dir() and any(SHAPE_CORPUS_DIR.iterdir()):
        try:
            n = _count_json(SHAPE_CORPUS_DIR)
        except Exception:
            n = -1
        _log(f"corpus source: baked/mounted at {SHAPE_CORPUS_DIR} (json_count={n})")
        return SHAPE_CORPUS_DIR

    if not ALLOW_RUNTIME_CLONE:
        _log(
            "FATAL: shape-chip corpus not found at "
            f"{SHAPE_CORPUS_DIR} and ALLOW_RUNTIME_CLONE=false. The image "
            "is expected to be built with the corpus staged under "
            "docker/testing-harness/corpus/shapes (CI does this from "
            "vpneoterra/forgenew using GH_PAT). Refusing to run."
        )
        sys.exit(2)

    clone_root = pathlib.Path("/tmp/forgenew-clone")
    if not clone_root.exists():
        _log(f"ALLOW_RUNTIME_CLONE=true -- cloning {FORGENEW_REPO} (depth 1) ...")
        subprocess.run(
            ["git", "clone", "--depth", "1", FORGENEW_REPO, str(clone_root)],
            check=True,
        )
    corpus = clone_root / FORGENEW_SUBPATH
    if not corpus.is_dir():
        raise RuntimeError(f"corpus subpath not found: {corpus}")
    try:
        n = _count_json(corpus)
    except Exception:
        n = -1
    _log(f"corpus source: runtime clone at {corpus} (json_count={n})")
    return corpus


def load_chip(path: pathlib.Path) -> dict:
    with path.open() as f:
        return json.load(f)


def discover_chips(root: pathlib.Path) -> list[pathlib.Path]:
    return sorted(root.rglob("*.json"))


def validate_count(chips: list[pathlib.Path]) -> None:
    """Hard guardrail: fail-closed if we don't have exactly the expected count."""
    found = len(chips)
    if found != EXPECTED_COUNT:
        _log(
            f"FATAL: expected {EXPECTED_COUNT} shape chips but discovered {found} "
            f"under {SHAPE_CORPUS_DIR}. Refusing to run. Override via "
            f"EXPECTED_SHAPE_CHIP_COUNT only if you have verified the corpus."
        )
        sys.exit(2)
    _log(f"count guardrail OK: {found} chips")


def health_probe() -> None:
    if not OMNI_BASE_URL:
        _log("FATAL: OMNI_BASE_URL is not set. Refusing to run.")
        sys.exit(5)
    url = f"{OMNI_BASE_URL}{OMNI_HEALTH_PATH}"
    _log(f"probing OMNI health: {url}")
    try:
        r = requests.get(url, timeout=15)
    except requests.RequestException as e:
        _log(f"FATAL: OMNI health probe error: {e}")
        sys.exit(3)
    if r.status_code != 200:
        _log(f"FATAL: OMNI health probe returned {r.status_code}: {r.text[:200]}")
        sys.exit(3)
    _log("OMNI health OK")


def chip_to_bom_part(chip: dict) -> dict:
    """
    Map a shape-chip JSON to the BomPartJson shape OMNI's SdfRenderEndpoint
    expects (see docker/omni/src/Api/SdfRenderEndpoint.cs).

    Mapping:
      Name         = payload.name
      Parameters   = payload.defaults (numeric params only)
      SdfClass     = payload.name         (best-effort hint; OMNI may override)
      Construction = [payload.composition_ast.type] if primitive
      Classification.Class = payload.industry_classification.hierarchy.sub_industry
    """
    p = chip.get("payload", {}) or {}
    defaults = p.get("defaults", {}) or {}
    # Keep only numeric default params; OMNI's adapter only reads numbers.
    params: dict[str, float] = {
        k: float(v) for k, v in defaults.items()
        if isinstance(v, (int, float))
    }

    comp = p.get("composition_ast", {}) or {}
    construction: list[str] = []
    if comp.get("kind") == "primitive" and isinstance(comp.get("type"), str):
        construction.append(comp["type"])

    classification: dict[str, str] = {}
    ic = p.get("industry_classification", {}) or {}
    hier = ic.get("hierarchy", {}) or {}
    if hier.get("sub_industry"):
        classification = {"class": hier["sub_industry"]}

    part: dict[str, t.Any] = {
        "name": p.get("name") or chip.get("chip_id", "unknown_part"),
        "description": p.get("canonical_description", ""),
        "sdf_class": p.get("name") or "",
        "parameters": params,
        "construction": construction,
    }
    if classification:
        part["classification"] = classification
    return part


# OMNI surfaces voxel_budget_exceeded with a concrete minimum voxel size in
# the error string, e.g. "voxel_budget_exceeded ... suggested voxelSize >= 0.2693".
# Match the numeric suggestion so the runner can retry once at that size.
_VOXEL_SUGGESTION_RE = re.compile(
    r"voxelSize\s*>=\s*([0-9]+(?:\.[0-9]+)?)",
    re.IGNORECASE,
)


def _parse_voxel_suggestion(err: t.Optional[str]) -> t.Optional[float]:
    if not err or "voxel_budget" not in err.lower():
        return None
    m = _VOXEL_SUGGESTION_RE.search(err)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _failure_type(result: dict) -> t.Optional[str]:
    if result.get("ok"):
        return None
    err = str(result.get("error") or "").lower()
    if "voxel_budget" in err:
        return "voxel_budget_exceeded"
    if err.startswith("http 4"):
        return "http_4xx"
    if err.startswith("http 5"):
        return "http_5xx"
    if err.startswith("transport:"):
        if "timeout" in err or "timed out" in err:
            return "transport_timeout"
        return "transport_error"
    if "non-json" in err:
        return "non_json_response"
    if err:
        return "render_error"
    return "unknown"


def _attempt_from_result(result: dict) -> dict:
    return {
        "ok": bool(result.get("ok")),
        "voxel_size_mm": result.get("voxel_size_mm"),
        "elapsed_ms": result.get("elapsed_ms"),
        "failure_type": _failure_type(result),
        "error": result.get("error"),
    }


def _with_attempts(result: dict, attempts: list[dict]) -> dict:
    result["attempts"] = attempts
    result["failure_type"] = _failure_type(result)
    return result


def _render_once(
    session: requests.Session,
    chip: dict,
    part: dict,
    voxel_size_mm: float,
) -> dict:
    url = f"{OMNI_BASE_URL}{OMNI_RENDER_PATH}"
    # OMNI's /api/sdf/render DTO is currently a C# Minimal API model with
    # VoxelSizeMm / OutputPath properties, while earlier harness notes used
    # snake_case names. Send both forms so the live endpoint receives the
    # requested voxel size instead of silently falling back to its 0.2mm
    # default, and keep compatibility if OMNI later adds snake_case aliases.
    body = {
        "part": part,
        "voxelSizeMm": voxel_size_mm,
        "voxel_size_mm": voxel_size_mm,
        "outputPath": f"/output/{part['name']}.stl",
        "output_path": f"/output/{part['name']}.stl",
    }
    t0 = time.monotonic()
    try:
        r = session.post(url, json=body, timeout=PER_PART_TIMEOUT_SEC)
    except requests.RequestException as e:
        return {
            "chip_id": chip.get("chip_id"),
            "name": part["name"],
            "ok": False,
            "error": f"transport: {e}",
            "voxel_size_mm": voxel_size_mm,
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
        }
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    if r.status_code != 200:
        return {
            "chip_id": chip.get("chip_id"),
            "name": part["name"],
            "ok": False,
            "error": f"http {r.status_code}: {r.text[:300]}",
            "voxel_size_mm": voxel_size_mm,
            "elapsed_ms": elapsed_ms,
        }
    try:
        data = r.json()
    except ValueError:
        return {
            "chip_id": chip.get("chip_id"),
            "name": part["name"],
            "ok": False,
            "error": "non-json response",
            "voxel_size_mm": voxel_size_mm,
            "elapsed_ms": elapsed_ms,
        }
    success = bool(data.get("Success") or data.get("success"))
    return {
        "chip_id": chip.get("chip_id"),
        "name": part["name"],
        "ok": success,
        "strategy": data.get("Strategy") or data.get("strategy"),
        "is_fallback": data.get("IsFallback") or data.get("is_fallback"),
        "error": None if success else (data.get("Error") or data.get("error")),
        "voxel_size_mm": voxel_size_mm,
        "elapsed_ms": elapsed_ms,
    }


def render_one(session: requests.Session, chip: dict) -> dict:
    part = chip_to_bom_part(chip)
    result = _render_once(session, chip, part, DEFAULT_VOXEL_SIZE_MM)
    attempts = [_attempt_from_result(result)]
    if result["ok"] or not VOXEL_BUDGET_RETRY:
        return _with_attempts(result, attempts)

    suggested = _parse_voxel_suggestion(result.get("error"))
    if suggested is None:
        return _with_attempts(result, attempts)

    retry_voxel = suggested * VOXEL_SIZE_SAFETY_MULT
    if retry_voxel <= DEFAULT_VOXEL_SIZE_MM:
        # Suggestion was lower than what we just tried; no point retrying.
        return _with_attempts(result, attempts)
    if retry_voxel > MAX_VOXEL_SIZE_MM:
        _log(
            f"  {part['name']}: voxel_budget_exceeded suggests voxelSize>={suggested} "
            f"(retry={retry_voxel:.4f}) exceeds MAX_VOXEL_SIZE_MM={MAX_VOXEL_SIZE_MM}; "
            f"not retrying."
        )
        return _with_attempts(result, attempts)

    _log(
        f"  {part['name']}: voxel_budget_exceeded at {DEFAULT_VOXEL_SIZE_MM}mm; "
        f"retrying once at {retry_voxel:.4f}mm "
        f"(suggested>={suggested}, mult={VOXEL_SIZE_SAFETY_MULT})"
    )
    retry_result = _render_once(session, chip, part, retry_voxel)
    attempts.append(_attempt_from_result(retry_result))
    retry_result["voxel_retry"] = {
        "initial_voxel_size_mm": DEFAULT_VOXEL_SIZE_MM,
        "suggested_min_voxel_size_mm": suggested,
        "retry_voxel_size_mm": retry_voxel,
    }
    return _with_attempts(retry_result, attempts)


def main() -> int:
    _log(f"FORGE tier-2 harness starting (env={os.environ.get('FORGE_ENV','?')})")
    corpus = ensure_corpus()
    chips = discover_chips(corpus)
    validate_count(chips)

    health_probe()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results_path = OUTPUT_DIR / "tier2-results.jsonl"
    summary_path = OUTPUT_DIR / "tier2-summary.json"

    session = requests.Session()
    if OMNI_API_KEY:
        session.headers["X-API-Key"] = OMNI_API_KEY

    if SHAPE_START_INDEX < 0:
        _log(f"FATAL: SHAPE_START_INDEX must be >= 0 (got {SHAPE_START_INDEX})")
        return 5

    chips_to_run = chips[SHAPE_START_INDEX:SHAPE_START_INDEX + MAX_PARTS_PER_RUN]
    _log(
        f"running {len(chips_to_run)} chips against {OMNI_BASE_URL}{OMNI_RENDER_PATH} "
        f"(start_index={SHAPE_START_INDEX}, limit={MAX_PARTS_PER_RUN}, stop_on_failure={STOP_ON_FAILURE})"
    )

    ok = 0
    failed = 0
    with results_path.open("w") as out:
        for i, path in enumerate(chips_to_run, start=1):
            shape_index = SHAPE_START_INDEX + i - 1
            chip = load_chip(path)
            result = render_one(session, chip)
            result["shape_index"] = shape_index
            result["run_index"] = i
            result["source_path"] = str(path.relative_to(corpus))
            out.write(json.dumps(result, sort_keys=True) + "\n")
            out.flush()
            _log_structured(RESULT_LOG_PREFIX, result)
            if result["ok"]:
                ok += 1
            else:
                failed += 1
                _log(f"  [{i}/{len(chips_to_run)}] FAIL {result['name']}: {result['error']}")
                if STOP_ON_FAILURE:
                    _log("STOP_ON_FAILURE=true -- stopping after first failed chip")
                    break
            if i % 25 == 0:
                _log(f"  progress {i}/{len(chips_to_run)} (ok={ok} failed={failed})")

    summary = {
        "total": len(chips_to_run),
        "ok": ok,
        "failed": failed,
        "start_index": SHAPE_START_INDEX,
        "limit": MAX_PARTS_PER_RUN,
        "stop_on_failure": STOP_ON_FAILURE,
        "omni_base_url": OMNI_BASE_URL,
        "omni_render_path": OMNI_RENDER_PATH,
        "voxel_size_mm": DEFAULT_VOXEL_SIZE_MM,
        "voxel_budget_retry": {
            "enabled": VOXEL_BUDGET_RETRY,
            "safety_mult": VOXEL_SIZE_SAFETY_MULT,
            "max_voxel_size_mm": MAX_VOXEL_SIZE_MM,
        },
        "results_file": str(results_path),
    }
    with summary_path.open("w") as f:
        json.dump(summary, f, indent=2)
    _log_structured(SUMMARY_LOG_PREFIX, summary)

    _log(f"DONE: ok={ok} failed={failed} total={len(chips_to_run)}")
    _log(f"summary: {summary_path}")
    return 0 if failed == 0 else 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover
        _log(f"FATAL: unhandled exception: {exc!r}")
        sys.exit(1)
