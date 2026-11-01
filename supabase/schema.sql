-- Production vector store for the Internal Knowledge Assistant (Supabase / Postgres + pgvector).
-- Written to by n8n/knowledge-ingest.n8n.json, queried by the /api/ask production path.

create extension if not exists vector;

create table if not exists kb_chunks (
  chunk_id        text primary key,              -- "<source>:<docId>#<n>"
  doc_id          text not null,
  source          text not null check (source in ('gdrive', 'notion', 'upload')),
  title           text not null,
  url             text,
  section         text,
  content         text not null,
  content_hash    text not null,
  token_estimate  int,
  embedding       vector(1536) not null,          -- OpenAI text-embedding-3-small
  embedding_model text not null default 'text-embedding-3-small',
  acl_groups      text[] not null default '{everyone}', -- who may retrieve this chunk
  updated_at      timestamptz,
  ingested_at     timestamptz not null default now(),
  fts             tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(section, '')), 'A') ||
                    setweight(to_tsvector('english', content), 'B')) stored
);

create index if not exists kb_chunks_doc_idx on kb_chunks (doc_id);
create index if not exists kb_chunks_fts_idx on kb_chunks using gin (fts);
create index if not exists kb_chunks_embedding_idx on kb_chunks using hnsw (embedding vector_cosine_ops);

-- Hybrid retrieval: dense (cosine) + sparse (full-text) fused with Reciprocal Rank Fusion,
-- filtered by the caller's groups so people only retrieve what they are allowed to read.
create or replace function match_kb_chunks(
  query_embedding vector(1536),
  query_text      text,
  match_count     int     default 6,
  user_groups     text[]  default '{everyone}',
  rrf_k           int     default 50
)
returns table (chunk_id text, doc_id text, title text, section text, url text, content text,
               similarity float, keyword_rank float, score float)
language sql stable as $$
  with dense as (
    select c.chunk_id, 1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as r
    from kb_chunks c
    where c.acl_groups && user_groups
    order by c.embedding <=> query_embedding
    limit match_count * 4
  ),
  sparse as (
    select c.chunk_id, ts_rank_cd(c.fts, q) as keyword_rank,
           row_number() over (order by ts_rank_cd(c.fts, q) desc) as r
    from kb_chunks c, websearch_to_tsquery('english', query_text) q
    where c.fts @@ q and c.acl_groups && user_groups
    order by keyword_rank desc
    limit match_count * 4
  ),
  fused as (
    select coalesce(d.chunk_id, s.chunk_id) as chunk_id,
           coalesce(d.similarity, 0) as similarity,
           coalesce(s.keyword_rank, 0) as keyword_rank,
           coalesce(1.0 / (rrf_k + d.r), 0) + coalesce(1.0 / (rrf_k + s.r), 0) as score
    from dense d full outer join sparse s on d.chunk_id = s.chunk_id
  )
  select c.chunk_id, c.doc_id, c.title, c.section, c.url, c.content, f.similarity, f.keyword_rank, f.score
  from fused f join kb_chunks c using (chunk_id)
  order by f.score desc
  limit match_count;
$$;

-- Remove chunks that disappeared from an edited document.
create or replace function prune_doc_chunks(p_doc_id text, p_keep_ids text[])
returns int language plpgsql as $$
declare n int;
begin
  delete from kb_chunks where doc_id = p_doc_id and not (chunk_id = any (p_keep_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- Answer log for evaluation and analytics (what people ask, what was found, feedback).
create table if not exists kb_questions (
  id          bigint generated always as identity primary key,
  asked_at    timestamptz not null default now(),
  question    text not null,
  found       boolean not null,
  confidence  float,
  chunk_ids   text[],
  latency_ms  int,
  feedback    smallint check (feedback in (-1, 1))
);

alter table kb_chunks enable row level security;   -- only the service role (n8n, API) touches it
alter table kb_questions enable row level security;
