-- ABC Dataset index tables (forge-dks project)
-- Companion to s3://forge-platform-data/abc/v00/* and EFS /data/datasets/abc/v00/*
-- See docs/abc-ingest.md for the ingest pipeline.

-- ── abc_chunks ────────────────────────────────────────────────────────────
-- One row per (format, chunk_id) archive landed in S3.
create table if not exists public.abc_chunks (
    chunk_id        text        not null,             -- e.g. "0000_0009999"
    format          text        not null,             -- meta|step|para|stl|stl2|obj|feat|stat|ofs
    version         text        not null default 'v00',
    source_url      text        not null,             -- canonical ABC URL
    s3_uri          text        not null,             -- s3://forge-platform-data/abc/v00/raw/{format}/...
    bytes           bigint,
    md5             text,
    md5_verified    boolean     not null default false,
    staged_at       timestamptz,
    extracted_at    timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    primary key (version, format, chunk_id)
);
comment on table public.abc_chunks is 'ABC dataset: one row per chunk archive landed in S3. Populated by abc-stage-to-s3 workflow.';

create index if not exists abc_chunks_format_idx on public.abc_chunks(format);
create index if not exists abc_chunks_staged_idx on public.abc_chunks(staged_at) where staged_at is not null;

-- ── abc_parts ─────────────────────────────────────────────────────────────
-- One row per CAD part (8-character ABC ID).
create table if not exists public.abc_parts (
    part_id         text        primary key,           -- 8-char ABC ID
    version         text        not null default 'v00',
    chunk_id        text        not null,
    formats         text[]      not null default '{}', -- which formats are present
    onshape_meta    jsonb,                             -- parsed from meta YAML
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
comment on table public.abc_parts is 'ABC dataset: one row per CAD part. formats[] enumerates which file types are available for this part.';

create index if not exists abc_parts_chunk_idx on public.abc_parts(chunk_id);
create index if not exists abc_parts_formats_gin on public.abc_parts using gin(formats);
create index if not exists abc_parts_onshape_meta_gin on public.abc_parts using gin(onshape_meta jsonb_path_ops);

-- ── abc_files ─────────────────────────────────────────────────────────────
-- One row per (part_id, format) addressable file.
create table if not exists public.abc_files (
    part_id         text        not null references public.abc_parts(part_id) on delete cascade,
    format          text        not null,
    s3_uri          text,                              -- inside chunk archive — pointer for re-extraction
    efs_path        text,                              -- /data/datasets/abc/v00/{format}/extracted/...
    bytes           bigint,
    md5             text,
    extracted_at    timestamptz,
    created_at      timestamptz not null default now(),
    primary key (part_id, format)
);
comment on table public.abc_files is 'ABC dataset: per-part file locations. efs_path populated only after abc-extract-to-efs runs for the chunk.';

create index if not exists abc_files_format_idx on public.abc_files(format);

-- ── abc_features ──────────────────────────────────────────────────────────
-- Operator-distribution stats parsed from feat YAML. One row per part.
create table if not exists public.abc_features (
    part_id         text        primary key references public.abc_parts(part_id) on delete cascade,
    n_faces         integer,
    n_edges         integer,
    n_vertices      integer,
    n_planar        integer,
    n_cylinder      integer,
    n_cone          integer,
    n_sphere        integer,
    n_torus         integer,
    n_revolution    integer,
    n_extrusion     integer,
    n_nurbs         integer,
    n_other         integer,
    n_sharp_edges   integer,
    raw_stats       jsonb,                             -- catch-all for fields not promoted to columns
    created_at      timestamptz not null default now()
);
comment on table public.abc_features is 'ABC dataset: per-part B-rep operator statistics from feat YAML. Drives FORGE/AXIOM workload characterization queries.';

-- ── updated_at trigger ────────────────────────────────────────────────────
create or replace function public.abc_set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists abc_chunks_updated_at on public.abc_chunks;
create trigger abc_chunks_updated_at before update on public.abc_chunks
    for each row execute function public.abc_set_updated_at();

drop trigger if exists abc_parts_updated_at on public.abc_parts;
create trigger abc_parts_updated_at before update on public.abc_parts
    for each row execute function public.abc_set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Pattern matches existing dks_runlog (rls_enabled=false) — these tables are
-- read-only public reference data for FORGE agents. Writes are restricted to
-- the service role used by the ingest workflows.
alter table public.abc_chunks   enable row level security;
alter table public.abc_parts    enable row level security;
alter table public.abc_files    enable row level security;
alter table public.abc_features enable row level security;

-- Read-only access for authenticated users
drop policy if exists abc_chunks_select   on public.abc_chunks;
drop policy if exists abc_parts_select    on public.abc_parts;
drop policy if exists abc_files_select    on public.abc_files;
drop policy if exists abc_features_select on public.abc_features;

create policy abc_chunks_select   on public.abc_chunks   for select using (true);
create policy abc_parts_select    on public.abc_parts    for select using (true);
create policy abc_files_select    on public.abc_files    for select using (true);
create policy abc_features_select on public.abc_features for select using (true);

-- Writes require service_role (bypasses RLS by default in Supabase)
