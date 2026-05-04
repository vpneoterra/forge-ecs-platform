#!/usr/bin/env python3
"""Upsert abc_chunks rows from S3 state stubs.

Reads s3://${bucket}/abc/${version}/state/${format}/<chunk_id>.json
written by abc-stage-to-s3 and inserts/updates the corresponding rows in
public.abc_chunks. Idempotent.

Env:
  SUPABASE_DB_URL    postgres connection string for forge-dks (service_role)

Usage:
  python upsert_chunks.py --bucket forge-platform-data-XXX-us-east-1 --version v00
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import boto3
import psycopg
import yaml


def iter_state_objects(s3, bucket: str, version: str):
    paginator = s3.get_paginator("list_objects_v2")
    prefix = f"abc/{version}/state/"
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if not key.endswith(".json"):
                continue
            yield key


def load_md5_size(s3, bucket: str, version: str) -> tuple[dict[str, str], dict[str, int]]:
    md5_obj = s3.get_object(Bucket=bucket, Key=f"abc/{version}/manifests/md5.yml")
    size_obj = s3.get_object(Bucket=bucket, Key=f"abc/{version}/manifests/size.yml")
    md5_map = yaml.safe_load(md5_obj["Body"].read()) or {}
    size_map = yaml.safe_load(size_obj["Body"].read()) or {}
    return md5_map, {k: int(v) for k, v in size_map.items()}


UPSERT_SQL = """
insert into public.abc_chunks
    (chunk_id, format, version, source_url, s3_uri, bytes, md5, md5_verified, staged_at)
values
    (%(chunk_id)s, %(format)s, %(version)s, %(source_url)s, %(s3_uri)s,
     %(bytes)s, %(md5)s, %(md5_verified)s, %(staged_at)s)
on conflict (version, format, chunk_id) do update set
    source_url   = excluded.source_url,
    s3_uri       = excluded.s3_uri,
    bytes        = excluded.bytes,
    md5          = excluded.md5,
    md5_verified = excluded.md5_verified,
    staged_at    = excluded.staged_at
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--version", default="v00")
    args = ap.parse_args()

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("error: SUPABASE_DB_URL not set", file=sys.stderr)
        return 2

    s3 = boto3.client("s3")
    md5_map, size_map = load_md5_size(s3, args.bucket, args.version)

    rows: list[dict[str, Any]] = []
    for key in iter_state_objects(s3, args.bucket, args.version):
        body = s3.get_object(Bucket=args.bucket, Key=key)["Body"].read()
        st = json.loads(body)
        fname = st.get("filename") or os.path.basename(st.get("s3_uri", ""))
        rows.append({
            "chunk_id": st["chunk_id"],
            "format": st["format"],
            "version": args.version,
            "source_url": st.get("source_url", ""),
            "s3_uri": st["s3_uri"],
            "bytes": int(st.get("bytes") or size_map.get(fname, 0)),
            "md5": md5_map.get(fname),
            "md5_verified": bool(st.get("md5_verified")),
            "staged_at": st.get("staged_at"),
        })

    print(f"loading {len(rows)} chunk rows into abc_chunks")
    if not rows:
        return 0
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, rows)
        conn.commit()
    print(f"upserted {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
