#!/usr/bin/env python3
"""ABC stage-to-S3: runs inside the dks-download Fargate container.

For each (format, chunk_id) in the configured ranges:
  1. Read the URL+filename from the per-format manifest in S3.
  2. Skip if the archive is already in s3://.../abc/{version}/raw/{format}/.
  3. Download the .7z to /tmp/abc/, optionally md5-verify against md5.yml.
  4. Upload to S3.
  5. Write a state stub JSON to s3://.../abc/{version}/state/{format}/{cid}.json.

All inputs come from environment variables (ABC_*). All outputs go to S3 — the
upsert step in the GitHub Actions runner reads the state stubs back to
populate Supabase public.abc_chunks.

Designed to run on python:3.11-slim-bookworm with awscli installed via pip.
Uses stdlib for downloads (urllib) and md5 (hashlib).
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def log(msg: str) -> None:
    print(msg, flush=True)


def env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        log(f"FATAL: missing env var {name}")
        sys.exit(2)
    return val


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """Run a subprocess and stream its output. Raises on non-zero exit."""
    return subprocess.run(cmd, check=True, **kw)


def s3_head(bucket: str, key: str) -> bool:
    r = subprocess.run(
        ["aws", "s3api", "head-object", "--bucket", bucket, "--key", key],
        capture_output=True,
    )
    return r.returncode == 0


def s3_cp(src: str, dst: str) -> None:
    run(["aws", "s3", "cp", src, dst, "--no-progress", "--only-show-errors"])


def s3_get_text(uri: str) -> str:
    """Read a small text object from S3 to memory."""
    r = subprocess.run(
        ["aws", "s3", "cp", uri, "-"], capture_output=True, check=True
    )
    return r.stdout.decode("utf-8")


def http_download(url: str, dest: Path, max_attempts: int = 5) -> None:
    """Download `url` to `dest` with simple retry/backoff. Stdlib only."""
    last_err: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            t0 = time.time()
            with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as out:
                # 4 MiB chunks — keeps memory low for multi-GB files.
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


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for buf in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(buf)
    return h.hexdigest()


def parse_md5_yml(text: str) -> dict[str, str]:
    """md5.yml is a tiny `<filename>: <md5>` map. We avoid pyyaml on purpose."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def main() -> int:
    bucket = env("ABC_BUCKET")
    version = env("ABC_VERSION")
    formats = [f.strip() for f in env("ABC_FORMATS").split(",") if f.strip()]
    chunk_start = int(env("ABC_CHUNK_START"))
    chunk_end = int(env("ABC_CHUNK_END"))
    verify = env("ABC_VERIFY_MD5", "true").lower() == "true"

    manifest_pfx = f"s3://{bucket}/abc/{version}/manifests"
    state_pfx = f"s3://{bucket}/abc/{version}/state"

    log(f"=== ABC stage-to-s3 (python) ===")
    log(f"bucket={bucket} version={version}")
    log(f"formats={formats}")
    log(f"chunks={chunk_start}..{chunk_end} verify_md5={verify}")

    workdir = Path("/tmp/abc")
    workdir.mkdir(parents=True, exist_ok=True)

    md5_map: dict[str, str] = {}
    if verify:
        log(f"loading md5.yml from {manifest_pfx}/md5.yml")
        md5_map = parse_md5_yml(s3_get_text(f"{manifest_pfx}/md5.yml"))
        log(f"  parsed {len(md5_map)} md5 entries")

    for fmt in formats:
        log(f"──── format={fmt} ────")
        manifest_uri = f"{manifest_pfx}/{fmt}_{version}.txt"
        try:
            manifest_lines = s3_get_text(manifest_uri).splitlines()
        except subprocess.CalledProcessError as e:
            log(f"::error::failed to read {manifest_uri}: {e}")
            return 3

        for cid_int in range(chunk_start, chunk_end + 1):
            cid = f"{cid_int:04d}"
            line_idx = cid_int  # manifests are 0-indexed by chunk_id
            if line_idx >= len(manifest_lines):
                log(f"  skip {fmt} chunk {cid}: no row in manifest")
                continue
            row = manifest_lines[line_idx].strip()
            if not row:
                log(f"  skip {fmt} chunk {cid}: blank row")
                continue
            parts = row.split()
            if len(parts) < 2:
                log(f"  skip {fmt} chunk {cid}: malformed row '{row}'")
                continue
            url, fname = parts[0], parts[1]
            s3_key = f"abc/{version}/raw/{fmt}/{fname}"

            if s3_head(bucket, s3_key):
                log(f"  ✓ already staged: {fname}")
                continue

            log(f"  ↓ {fname} from {url}")
            local = workdir / fname
            try:
                http_download(url, local)
            except Exception as e:  # noqa: BLE001
                log(f"::error::download failed for {fname}: {e}")
                return 4

            if verify:
                expected = md5_map.get(fname)
                actual = md5_of(local)
                if expected and expected != actual:
                    log(f"::error::md5 mismatch {fname}: expected={expected} actual={actual}")
                    local.unlink(missing_ok=True)
                    return 5
                log(f"  ✓ md5 ok ({actual})")

            size = local.stat().st_size
            log(f"  ↑ s3 cp -> s3://{bucket}/{s3_key}")
            s3_cp(str(local), f"s3://{bucket}/{s3_key}")

            state = {
                "chunk_id": cid,
                "format": fmt,
                "filename": fname,
                "source_url": url,
                "s3_uri": f"s3://{bucket}/{s3_key}",
                "bytes": size,
                "md5_verified": verify,
                "staged_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            state_path = Path("/tmp/state.json")
            state_path.write_text(json.dumps(state))
            s3_cp(str(state_path), f"{state_pfx}/{fmt}/{cid}.json")
            local.unlink(missing_ok=True)
            log(f"  ✓ uploaded {fname} ({size:,} bytes)")

    log("=== done ===")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        # Surface the failed command for easier debugging.
        cmd = " ".join(shlex.quote(c) for c in e.cmd) if isinstance(e.cmd, list) else str(e.cmd)
        log(f"::error::subprocess failed: {cmd} (exit {e.returncode})")
        if e.stdout:
            log(e.stdout.decode("utf-8", errors="replace"))
        if e.stderr:
            log(e.stderr.decode("utf-8", errors="replace"))
        sys.exit(e.returncode or 1)
