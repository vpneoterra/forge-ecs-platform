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
import subprocess
import sys
import time
import typing as t

import requests


# ── Config loaded from env (mirrors CDK task-def injections) ─────────────
EXPECTED_COUNT        = int(os.environ.get("EXPECTED_SHAPE_CHIP_COUNT", "313"))
MAX_PARTS_PER_RUN     = int(os.environ.get("MAX_PARTS_PER_RUN", str(EXPECTED_COUNT)))
OMNI_BASE_URL         = os.environ.get("OMNI_BASE_URL", "").rstrip("/")
OMNI_RENDER_PATH      = os.environ.get("OMNI_RENDER_PATH", "/api/sdf/render")
OMNI_HEALTH_PATH      = os.environ.get("OMNI_HEALTH_PATH", "/api/health")
PER_PART_TIMEOUT_SEC  = int(os.environ.get("PER_PART_TIMEOUT_SEC", "120"))
DEFAULT_VOXEL_SIZE_MM = float(os.environ.get("DEFAULT_VOXEL_SIZE_MM", "0.5"))

SHAPE_CORPUS_DIR      = pathlib.Path(os.environ.get("SHAPE_CORPUS_DIR", "/corpus/shapes"))
FORGENEW_REPO         = os.environ.get("FORGENEW_REPO", "https://github.com/vpneoterra/forgenew.git")
FORGENEW_SUBPATH      = os.environ.get("FORGENEW_SUBPATH", "server/axiom/chips/shapes")
# ECS tasks must not hold GitHub credentials, so runtime cloning is off
# by default. Set ALLOW_RUNTIME_CLONE=true + a public/anonymous-readable
# FORGENEW_REPO to re-enable the old fallback path.
ALLOW_RUNTIME_CLONE   = os.environ.get("ALLOW_RUNTIME_CLONE", "false").lower() in ("1", "true", "yes")
OUTPUT_DIR            = pathlib.Path(os.environ.get("OUTPUT_DIR", "/tmp/harness-output"))

OMNI_API_KEY          = os.environ.get("OMNI_API_KEY")  # optional


# ── Helpers ───────────────────────────────────────────────────────────────
def _log(msg: str) -> None:
    print(f"[harness] {msg}", flush=True)


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


def render_one(session: requests.Session, chip: dict) -> dict:
    part = chip_to_bom_part(chip)
    url = f"{OMNI_BASE_URL}{OMNI_RENDER_PATH}"
    body = {
        "part": part,
        "voxel_size_mm": DEFAULT_VOXEL_SIZE_MM,
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
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
        }
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    if r.status_code != 200:
        return {
            "chip_id": chip.get("chip_id"),
            "name": part["name"],
            "ok": False,
            "error": f"http {r.status_code}: {r.text[:300]}",
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
        "elapsed_ms": elapsed_ms,
    }


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

    chips_to_run = chips[:MAX_PARTS_PER_RUN]
    _log(f"running {len(chips_to_run)} chips against {OMNI_BASE_URL}{OMNI_RENDER_PATH}")

    ok = 0
    failed = 0
    with results_path.open("w") as out:
        for i, path in enumerate(chips_to_run, start=1):
            chip = load_chip(path)
            result = render_one(session, chip)
            result["source_path"] = str(path.relative_to(corpus))
            out.write(json.dumps(result) + "\n")
            if result["ok"]:
                ok += 1
            else:
                failed += 1
                _log(f"  [{i}/{len(chips_to_run)}] FAIL {result['name']}: {result['error']}")
            if i % 25 == 0:
                _log(f"  progress {i}/{len(chips_to_run)} (ok={ok} failed={failed})")

    summary = {
        "total": len(chips_to_run),
        "ok": ok,
        "failed": failed,
        "omni_base_url": OMNI_BASE_URL,
        "omni_render_path": OMNI_RENDER_PATH,
        "voxel_size_mm": DEFAULT_VOXEL_SIZE_MM,
        "results_file": str(results_path),
    }
    with summary_path.open("w") as f:
        json.dump(summary, f, indent=2)

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
