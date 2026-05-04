#!/usr/bin/env python3
"""Upsert abc_parts / abc_files / abc_features from an extract-run manifest.

Reads the JSON array written by abc-extract-to-efs.yml at
s3://.../abc/${version}/runs/extract-<run_id>.json. Each element:
    {part_id, chunk_id, format, efs_path, bytes, filename}

Populates:
  - abc_parts   : one row per part_id, formats[] = union of all formats seen
  - abc_files   : one row per (part_id, format)
  - abc_features: parsed from the feat YAML when format=='feat'
  - abc_chunks.extracted_at : marked when at least one row for that
    (version, format, chunk_id) lands here

Env:
  SUPABASE_DB_URL    postgres connection string for forge-dks
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from collections import defaultdict
from typing import Any

import boto3
import psycopg
import yaml


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


def parse_s3_uri(uri: str) -> tuple[str, str]:
    assert uri.startswith("s3://")
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def features_from_feat_yaml(yaml_bytes: bytes) -> dict[str, Any]:
    """Best-effort parse of an ABC feat YAML.

    feat YAML structure (per ABC docs):
      surfaces:
        - type: Plane | Cylinder | ... | BSpline
          ...
      curves: [ ... ]
    Sharp edge counts are surfaced under various keys depending on chunk
    age; we look for a 'sharp' / 'is_sharp' boolean in each curve entry.
    """
    try:
        data = yaml.safe_load(yaml_bytes) or {}
    except yaml.YAMLError:
        return {}
    surfaces = data.get("surfaces") or []
    curves = data.get("curves") or []
    counts = defaultdict(int)
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
        "n_vertices":   None,  # not directly in feat; derive later if needed
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


PARTS_UPSERT = """
insert into public.abc_parts (part_id, version, chunk_id, formats)
values (%(part_id)s, %(version)s, %(chunk_id)s, %(formats)s)
on conflict (part_id) do update set
  formats = (
    select array(select distinct unnest(public.abc_parts.formats || excluded.formats))
  ),
  chunk_id = coalesce(public.abc_parts.chunk_id, excluded.chunk_id)
"""

FILES_UPSERT = """
insert into public.abc_files (part_id, format, efs_path, bytes, extracted_at)
values (%(part_id)s, %(format)s, %(efs_path)s, %(bytes)s, now())
on conflict (part_id, format) do update set
  efs_path = excluded.efs_path,
  bytes    = excluded.bytes,
  extracted_at = excluded.extracted_at
"""

FEATURES_UPSERT = """
insert into public.abc_features (
  part_id, n_faces, n_edges, n_vertices,
  n_planar, n_cylinder, n_cone, n_sphere, n_torus,
  n_revolution, n_extrusion, n_nurbs, n_other, n_sharp_edges, raw_stats
) values (
  %(part_id)s, %(n_faces)s, %(n_edges)s, %(n_vertices)s,
  %(n_planar)s, %(n_cylinder)s, %(n_cone)s, %(n_sphere)s, %(n_torus)s,
  %(n_revolution)s, %(n_extrusion)s, %(n_nurbs)s, %(n_other)s, %(n_sharp_edges)s, %(raw_stats)s
)
on conflict (part_id) do update set
  n_faces=excluded.n_faces, n_edges=excluded.n_edges,
  n_planar=excluded.n_planar, n_cylinder=excluded.n_cylinder, n_cone=excluded.n_cone,
  n_sphere=excluded.n_sphere, n_torus=excluded.n_torus,
  n_revolution=excluded.n_revolution, n_extrusion=excluded.n_extrusion,
  n_nurbs=excluded.n_nurbs, n_other=excluded.n_other,
  n_sharp_edges=excluded.n_sharp_edges, raw_stats=excluded.raw_stats
"""

CHUNK_MARK_EXTRACTED = """
update public.abc_chunks
   set extracted_at = now()
 where version = %s and format = %s and chunk_id = %s
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest-uri", required=True)
    ap.add_argument("--version", default="v00")
    args = ap.parse_args()

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("error: SUPABASE_DB_URL not set", file=sys.stderr)
        return 2

    s3 = boto3.client("s3")
    bucket, key = parse_s3_uri(args.manifest_uri)
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    rows = json.loads(body or "[]")
    print(f"manifest rows: {len(rows)}")

    if not rows:
        return 0

    parts: dict[str, dict[str, Any]] = {}
    files: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []
    chunk_marks: set[tuple[str, str, str]] = set()

    for r in rows:
        pid = r["part_id"]
        fmt = r["format"]
        cid = r["chunk_id"]
        chunk_marks.add((args.version, fmt, cid))
        parts.setdefault(pid, {
            "part_id": pid, "version": args.version,
            "chunk_id": cid, "formats": [],
        })
        if fmt not in parts[pid]["formats"]:
            parts[pid]["formats"].append(fmt)
        files.append({
            "part_id": pid, "format": fmt,
            "efs_path": r["efs_path"], "bytes": int(r.get("bytes") or 0),
        })
        if fmt == "feat" and r["filename"].endswith(".yml"):
            try:
                with open(r["efs_path"], "rb") as f:
                    feat = features_from_feat_yaml(f.read())
                if feat:
                    feat["part_id"] = pid
                    feat["raw_stats"] = json.dumps({
                        "source_path": r["efs_path"],
                    })
                    features.append(feat)
            except OSError as e:
                print(f"warn: feat read failed for {pid}: {e}", file=sys.stderr)

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.executemany(PARTS_UPSERT, list(parts.values()))
            cur.executemany(FILES_UPSERT, files)
            if features:
                cur.executemany(FEATURES_UPSERT, features)
            for mark in chunk_marks:
                cur.execute(CHUNK_MARK_EXTRACTED, mark)
        conn.commit()

    print(f"upserted parts={len(parts)} files={len(files)} features={len(features)}"
          f" chunks_marked={len(chunk_marks)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
