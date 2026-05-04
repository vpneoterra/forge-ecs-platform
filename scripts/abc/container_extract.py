#!/usr/bin/env python3
"""ABC extract-to-EFS: runs inside the dks-download Fargate container.

For each (format, chunk_id) in the configured ranges:
  1. Skip if not staged in S3.
  2. Download raw .7z to /tmp/abc/.
  3. Extract via static `7zz` binary into /data/datasets/abc/{version}/{format}/extracted/.
  4. Walk the extracted tree, emit per-(part_id, file) JSON rows.
  5. Aggregate to a single manifest JSON and upload to s3://.../{run_key}.

The GitHub Actions runner reads that manifest and upserts abc_parts /
abc_files / abc_features into Supabase.

Container is python:3.11-slim-bookworm. apt mirrors are unreachable in this
subnet, so we fetch a static `7zz` binary from GitHub Releases over HTTPS.
"""
from __future__ import annotations

import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml
try:
    from yaml import CSafeLoader as _SafeLoader  # libyaml C ext, ~10x faster
except ImportError:
    from yaml import SafeLoader as _SafeLoader  # pure-python fallback

# Pinned 7-Zip version. Static linux-x64 binary, ~1.8 MiB compressed.
SEVENZIP_VERSION = "26.01"
SEVENZIP_URL = (
    f"https://github.com/ip7z/7zip/releases/download/{SEVENZIP_VERSION}/"
    f"7z{SEVENZIP_VERSION.replace('.', '')}-linux-x64.tar.xz"
)
SEVENZIP_BIN = Path("/usr/local/bin/7zz")


def log(msg: str) -> None:
    print(msg, flush=True)


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        log(f"FATAL: missing env var {name}")
        sys.exit(2)
    return val


def http_download(url: str, dest: Path, max_attempts: int = 5) -> None:
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            t0 = time.time()
            with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as out:
                while True:
                    buf = resp.read(4 * 1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)
            elapsed = time.time() - t0
            size = dest.stat().st_size
            mb_s = (size / 1024 / 1024) / max(elapsed, 0.001)
            log(f"  ↓ downloaded {size:,} bytes in {elapsed:.1f}s ({mb_s:.1f} MiB/s)")
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            log(f"  download attempt {attempt}/{max_attempts} failed: {e}")
            if attempt < max_attempts:
                time.sleep(min(30, 5 * attempt))
    raise RuntimeError(f"download failed after {max_attempts} attempts: {last_err}")


def install_7zz() -> None:
    """Fetch static 7zz binary from GitHub Releases and put it on PATH."""
    if SEVENZIP_BIN.exists():
        log(f"7zz already present at {SEVENZIP_BIN}")
        return
    log(f"installing 7zz {SEVENZIP_VERSION} from GitHub Releases")
    tar_path = Path("/tmp/7zz.tar.xz")
    http_download(SEVENZIP_URL, tar_path)
    # tarfile reads tar.xz natively (lzma is in stdlib).
    with tarfile.open(tar_path, "r:xz") as tf:
        # Archive contains 7zz, 7zzs, License.txt, MANUAL/, readme.txt
        member = next((m for m in tf.getmembers() if m.name == "7zz"), None)
        if member is None:
            raise RuntimeError("7zz binary not found inside archive")
        f = tf.extractfile(member)
        if f is None:
            raise RuntimeError("could not extract 7zz from archive")
        SEVENZIP_BIN.write_bytes(f.read())
    SEVENZIP_BIN.chmod(0o755)
    tar_path.unlink(missing_ok=True)
    log(f"installed 7zz -> {SEVENZIP_BIN}")
    subprocess.run([str(SEVENZIP_BIN), "--help"], check=True, capture_output=True)


def s3_head(bucket: str, key: str) -> bool:
    r = subprocess.run(
        ["aws", "s3api", "head-object", "--bucket", bucket, "--key", key],
        capture_output=True,
    )
    return r.returncode == 0


def s3_cp(src: str, dst: str) -> None:
    subprocess.run(
        ["aws", "s3", "cp", src, dst, "--no-progress", "--only-show-errors"],
        check=True,
    )


def extract_7z(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    cpu = os.cpu_count() or 2
    cmd = [str(SEVENZIP_BIN), "x", "-y", f"-mmt{cpu}", f"-o{dest}", str(archive)]
    log(f"  ↦ {' '.join(shlex.quote(c) for c in cmd)}")
    t0 = time.time()
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    log(f"  ↦ extracted in {time.time() - t0:.1f}s")


PART_RE = re.compile(r"^(\d{8})")

# ABC feat YAML "surface type" -> Supabase abc_features column.
SURFACE_TYPE_COLS = {
    "Plane":      "n_planar",
    "Cylinder":   "n_cylinder",
    "Cone":       "n_cone",
    "Sphere":     "n_sphere",
    "Torus":      "n_torus",
    "Revolution": "n_revolution",
    "Extrusion":  "n_extrusion",
    "BSpline":    "n_nurbs",
    "Other":      "n_other",
}


def _parse_feat_yaml(path: Path) -> dict | None:
    """Parse an ABC feat YAML using pyyaml.

    feat YAML structure (per ABC docs):
      surfaces:
        - type: Plane | Cylinder | Cone | Sphere | Torus |
                Revolution | Extrusion | BSpline | Other
          ... (vert_indices, vert_parameters, face_indices, etc.)
      curves:
        - sharp: true | false
          ...
    pyyaml correctly handles nested arrays (vert_indices etc.) that
    confuse line-based scanners. Returns None on parse / IO failure.
    """
    try:
        with open(path, "rb") as f:
            data = yaml.load(f, Loader=_SafeLoader) or {}
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(data, dict):
        return None
    surfaces = data.get("surfaces") or []
    curves = data.get("curves") or []
    counts: dict[str, int] = defaultdict(int)
    for s in surfaces:
        t = (s.get("type") or "Other") if isinstance(s, dict) else "Other"
        col = SURFACE_TYPE_COLS.get(t, "n_other")
        counts[col] += 1
    n_sharp = 0
    for c in curves:
        if isinstance(c, dict) and (c.get("sharp") or c.get("is_sharp")):
            n_sharp += 1
    return {
        "n_faces":      len(surfaces),
        "n_edges":      len(curves),
        "n_planar":     counts.get("n_planar", 0),
        "n_cylinder":   counts.get("n_cylinder", 0),
        "n_cone":       counts.get("n_cone", 0),
        "n_sphere":     counts.get("n_sphere", 0),
        "n_torus":      counts.get("n_torus", 0),
        "n_revolution": counts.get("n_revolution", 0),
        "n_extrusion":  counts.get("n_extrusion", 0),
        "n_nurbs":      counts.get("n_nurbs", 0),
        "n_other":      counts.get("n_other", 0),
        "n_sharp_edges": n_sharp,
    }


def walk_extracted(dest: Path, fmt: str, cid: str) -> list[dict]:
    """Enumerate (part_id, file) pairs under `dest`.

    ABC convention: extracted layout is `<dest>/<part_id>/<part_id>_*.<ext>`
    where part_id is an 8-digit prefix. For the `feat` format we also
    parse each YAML inline and attach feature counts so the GitHub
    Actions upsert step (which has no EFS access) can populate
    public.abc_features without re-reading the files.
    """
    rows: list[dict] = []
    if not dest.exists():
        return rows
    parts_seen = 0
    feat_parsed = 0
    walk_started = time.time()
    for d in sorted(dest.iterdir()):
        if not d.is_dir():
            continue
        m = PART_RE.match(d.name)
        if not m:
            continue
        part_id = m.group(1)
        parts_seen += 1
        for f in d.iterdir():
            if not f.is_file():
                continue
            try:
                size = f.stat().st_size
            except OSError:
                continue
            row = {
                "part_id": part_id,
                "chunk_id": cid,
                "format": fmt,
                "efs_path": str(f),
                "bytes": size,
                "filename": f.name,
            }
            if fmt == "feat" and f.name.endswith(".yml"):
                feat = _parse_feat_yaml(f)
                if feat is not None:
                    row["features"] = feat
                    feat_parsed += 1
            rows.append(row)
        if parts_seen % 500 == 0:
            log(f"    walked {parts_seen} parts (feat parsed={feat_parsed}, +{time.time()-walk_started:.1f}s)")
    log(f"    walked total {parts_seen} parts (feat parsed={feat_parsed}) in {time.time()-walk_started:.1f}s")
    return rows


def main() -> int:
    bucket = env("ABC_BUCKET")
    version = env("ABC_VERSION")
    formats = [f.strip() for f in env("ABC_FORMATS").split(",") if f.strip()]
    chunk_start = int(env("ABC_CHUNK_START"))
    chunk_end = int(env("ABC_CHUNK_END"))
    run_key = env("ABC_RUN_KEY")

    log(f"=== ABC extract-to-efs (python) ===")
    log(f"bucket={bucket} version={version}")
    log(f"formats={formats} chunks={chunk_start}..{chunk_end}")
    log(f"run_key={run_key}")

    install_7zz()

    efs_root = Path(f"/data/datasets/abc/{version}")
    workdir = Path("/tmp/abc")
    efs_root.mkdir(parents=True, exist_ok=True)
    workdir.mkdir(parents=True, exist_ok=True)

    all_rows: list[dict] = []

    for fmt in formats:
        dest = efs_root / fmt / "extracted"
        log(f"──── format={fmt}  dest={dest} ────")
        for cid_int in range(chunk_start, chunk_end + 1):
            cid = f"{cid_int:04d}"
            fname = f"abc_{cid}_{fmt}_{version}.7z"
            s3_key = f"abc/{version}/raw/{fmt}/{fname}"
            if not s3_head(bucket, s3_key):
                log(f"  skip (not staged): {fname}")
                continue
            log(f"  ↓ {fname}")
            local = workdir / fname
            s3_cp(f"s3://{bucket}/{s3_key}", str(local))
            try:
                extract_7z(local, dest)
            finally:
                local.unlink(missing_ok=True)
            rows = walk_extracted(dest, fmt, cid)
            log(f"  ↦ walked {len(rows)} files for {fmt} chunk {cid}")
            all_rows.extend(rows)

    manifest_path = Path("/tmp/extract_manifest.json")
    manifest_path.write_text(json.dumps(all_rows))
    log(f"manifest: {len(all_rows)} rows -> {manifest_path}")

    s3_cp(str(manifest_path), f"s3://{bucket}/{run_key}")
    log(f"manifest uploaded to s3://{bucket}/{run_key}")
    log("=== done ===")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        cmd = " ".join(shlex.quote(c) for c in e.cmd) if isinstance(e.cmd, list) else str(e.cmd)
        log(f"::error::subprocess failed: {cmd} (exit {e.returncode})")
        if e.stdout:
            log(e.stdout.decode("utf-8", errors="replace") if isinstance(e.stdout, bytes) else e.stdout)
        if e.stderr:
            log(e.stderr.decode("utf-8", errors="replace") if isinstance(e.stderr, bytes) else e.stderr)
        sys.exit(e.returncode or 1)
