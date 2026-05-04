#!/usr/bin/env python3
"""Build a frozen Parquet snapshot of the ABC index.

Reads abc_parts joined with abc_files (pivoted) and abc_features from
the live Supabase tables, writes a partitioned-friendly Parquet to
s3://${bucket}/abc/${version}/index/parts.parquet (and a versioned copy).

Env:
  SUPABASE_DB_URL    postgres connection string for forge-dks (read-only is fine)
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import os
import sys

import boto3
import psycopg


SQL = """
select
  p.part_id, p.version, p.chunk_id, p.formats,
  p.onshape_meta,
  feat.n_faces, feat.n_edges, feat.n_vertices,
  feat.n_planar, feat.n_cylinder, feat.n_cone, feat.n_sphere, feat.n_torus,
  feat.n_revolution, feat.n_extrusion, feat.n_nurbs, feat.n_other,
  feat.n_sharp_edges,
  (select jsonb_object_agg(f.format, f.efs_path)
     from public.abc_files f where f.part_id = p.part_id) as efs_paths,
  (select jsonb_object_agg(c.format, c.s3_uri)
     from public.abc_chunks c
    where c.version = p.version and c.chunk_id = p.chunk_id) as chunk_s3_uris
from public.abc_parts p
left join public.abc_features feat using (part_id)
where p.version = %s
order by p.part_id
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

    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        print("install pyarrow first: pip install pyarrow", file=sys.stderr)
        return 2

    print(f"reading abc_parts for version={args.version}")
    rows: list[dict] = []
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(SQL, (args.version,))
            cols = [d.name for d in cur.description]
            for r in cur:
                rows.append(dict(zip(cols, r)))
    print(f"got {len(rows)} parts")
    if not rows:
        print("no parts; nothing to write")
        return 0

    table = pa.Table.from_pylist(rows)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    body = buf.getvalue()
    print(f"parquet size: {len(body):,} bytes")

    ts = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    s3 = boto3.client("s3")
    versioned_key = f"abc/{args.version}/index/parts-{ts}.parquet"
    latest_key    = f"abc/{args.version}/index/parts.parquet"
    s3.put_object(Bucket=args.bucket, Key=versioned_key, Body=body,
                  ContentType="application/x-parquet")
    s3.put_object(Bucket=args.bucket, Key=latest_key, Body=body,
                  ContentType="application/x-parquet")
    print(f"wrote s3://{args.bucket}/{versioned_key}")
    print(f"wrote s3://{args.bucket}/{latest_key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
