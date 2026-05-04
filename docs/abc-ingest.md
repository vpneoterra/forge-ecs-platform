# ABC Dataset Ingest

Pipeline for landing the [ABC Dataset](https://deep-geometry.github.io/abc-dataset/)
(~1M Onshape-derived B-rep CAD models, 8 file formats, ~100 chunks per format)
into FORGE's storage and making it queryable for agents.

## Storage layout

| Layer        | Where                                                              | Purpose |
|--------------|--------------------------------------------------------------------|---------|
| Canonical    | `s3://forge-platform-data-${ACCOUNT}-us-east-1/abc/v00/raw/`       | Immutable archive copy of every chunk `.7z` |
| Manifests    | `s3://...forge-platform-data.../abc/v00/manifests/`                | Chunk-list TXTs, `md5.yml`, `size.yml`, provenance |
| State        | `s3://...forge-platform-data.../abc/v00/state/`                    | Per-chunk staging stub written by stage workflow |
| Run logs     | `s3://...forge-platform-data.../abc/v00/runs/`                     | Per-extract-run manifest JSON |
| Index snapshot | `s3://...forge-platform-data.../abc/v00/index/parts.parquet`     | Frozen Parquet for offline DuckDB / Athena |
| Working set  | EFS `/data/datasets/abc/v00/${format}/extracted/${part_id}/...`    | Materialized files for FORGE containers |
| Live index   | Supabase `forge-dks`: `abc_chunks`, `abc_parts`, `abc_files`, `abc_features` | Agent-facing SQL |

## Why this split

ABC at full coverage is roughly **2.8 TB** across all 8 formats × 100 chunks.
That's too large for either Supabase Storage egress allowances or always-on
EFS. S3 Intelligent-Tiering on the canonical copy plus on-demand EFS
materialization for the working set is materially cheaper.

The metadata index lives in Supabase Postgres (`forge-dks`) so every FORGE
agent can query it the same way they query `dks_runlog`, `design_knowledge_chunks`,
etc. Sub-second queries; no S3 listings or EFS walks at agent runtime.

## Workflows

```
abc-ingest-manifests   → S3:manifests/                 (~1 min, no Fargate)
        │
        ▼
abc-stage-to-s3        → S3:raw/      + abc_chunks      (Fargate, hours per chunk)
        │
        ▼
abc-extract-to-efs     → EFS + abc_parts/files/features (Fargate, ~10 min/chunk/format)
        │
        ▼
abc-build-index        → S3:index/parts.parquet         (~1 min)
```

All workflows are `workflow_dispatch` only — never automatic.

## Smoke run (recommended first pass)

This stages chunk 0 only, all 8 formats, end-to-end. Total ~28 GB through
S3, ~28 GB extracted on EFS, ~10k parts in `abc_parts`.

1. **Manifests.** Trigger `ABC: Ingest Manifests` with `version=v00`.
   Verify manifests landed:
   ```
   aws s3 ls s3://forge-platform-data-${ACCOUNT}-us-east-1/abc/v00/manifests/
   ```
   Expect 9 TXTs + `md5.yml` + `size.yml` + `provenance.yml`.

2. **Stage.** Trigger `ABC: Stage chunks to S3` with:
   ```
   version=v00  formats=all  chunk_range=0-0
   verify_md5=true  task_cpu=4096  task_memory=16384  task_ephemeral_gib=32
   ```
   Verify in Supabase:
   ```sql
   select format, count(*) from public.abc_chunks group by 1 order by 1;
   -- expect 8 rows, count=1 each
   ```

3. **Extract.** Trigger `ABC: Extract staged chunks to EFS` with:
   ```
   version=v00  formats=meta,step,feat,stat  chunk_range=0-0
   ```
   Smaller format set keeps the smoke run quick. Verify:
   ```sql
   select count(*) from public.abc_parts where chunk_id='0000';
   -- expect ~10000

   select count(*) from public.abc_features;
   -- > 0 once feat YAMLs parsed

   select format, count(*) from public.abc_files
    where part_id in (select part_id from abc_parts where chunk_id='0000')
    group by 1 order by 1;
   ```

4. **Index.** Trigger `ABC: Build Parquet index snapshot`. Verify:
   ```
   aws s3 ls s3://forge-platform-data-${ACCOUNT}-us-east-1/abc/v00/index/
   ```

## Full run (after smoke passes)

Same workflows, scaled out:

- `abc-stage-to-s3`: `chunk_range=all`. Run multiple times in parallel
  with disjoint format slices to fan out, e.g. one run for
  `formats=step,para`, one for `formats=feat,stat`, etc. Each run launches
  one Fargate task; multiple tasks run concurrently.
- `abc-extract-to-efs`: `chunk_range=all`, `formats=` whatever you actually
  want materialized on EFS. Most FORGE workloads only need `step + feat`
  on EFS; the rest can stay S3-only and be pulled on demand.
- `abc-build-index`: rerun after extract.

## Required GitHub secrets

| Secret                    | Used by                                              |
|---------------------------|------------------------------------------------------|
| `AWS_ACCESS_KEY_ID`       | All workflows (already exists)                       |
| `AWS_SECRET_ACCESS_KEY`   | All workflows (already exists)                       |
| `SUPABASE_DB_URL`         | Index upsert jobs. Postgres URL with **service_role** privileges on `forge-dks` (host `db.kcleqefmctfmnucepkwa.supabase.co`, schema `public`). |

`SUPABASE_DB_URL` example shape (do not commit a real value):
```
postgresql://postgres:<service_role_password>@db.kcleqefmctfmnucepkwa.supabase.co:5432/postgres?sslmode=require
```

## Sample agent queries

```sql
-- All parts in the corpus (live):
select part_id, formats from public.abc_parts order by part_id;

-- Parts that have both step and feat:
select part_id from public.abc_parts
 where 'step' = any(formats) and 'feat' = any(formats);

-- NURBS-dominant parts (operator-distribution selection):
select p.part_id, f.n_faces, f.n_nurbs,
       round(100.0 * f.n_nurbs / nullif(f.n_faces,0), 1) as pct_nurbs
  from public.abc_parts p
  join public.abc_features f using (part_id)
 where f.n_faces > 0 and f.n_nurbs::float / f.n_faces > 0.5
 order by pct_nurbs desc
 limit 100;

-- Resolve EFS path for a part's STEP file:
select efs_path from public.abc_files
 where part_id = '00000050' and format = 'step';
```

## CDK note

`lib/forge-app-stack.ts` (inside `if (props.deployDks)`) grants the shared
`taskRole` `s3:PutObject/GetObject` on
`arn:aws:s3:::forge-platform-data-${ACCOUNT}-${REGION}/abc/*`. No new task
definition is added — ABC reuses the existing `dks-download` Fargate family
with overrides at run-task time, mirroring the Fusion 360 pattern.

If you redeploy `ForgeAppStack` after this PR merges, the new IAM policy
takes effect on the next task launch automatically.

## Source

Dataset homepage: <https://deep-geometry.github.io/abc-dataset/>.
Hosting: NYU Faculty Digital Archive (`https://archive.nyu.edu/rest/bitstreams/...`).
License: per Onshape Terms of Use §1.g.ii — **not** CC BY 4.0 despite some
third-party summaries claiming otherwise. Review Onshape ToU before any
commercial deployment.
