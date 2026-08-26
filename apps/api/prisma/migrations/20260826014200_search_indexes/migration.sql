-- Search infrastructure that Prisma's schema language cannot express:
-- pgvector approximate-nearest-neighbour indexes and Postgres full-text vectors.

-- ── Vector search ────────────────────────────────────────────────────────────
-- HNSW gives sub-linear recall on cosine distance. m/ef_construction are tuned
-- for knowledge-base sized corpora (10^4-10^6 chunks) rather than raw ingest speed.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Lexical search over chunks ───────────────────────────────────────────────
-- 'simple' (not 'english') keeps the column IMMUTABLE and language-agnostic, which
-- matters because a tenant's knowledge may be Arabic, English or mixed.
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(heading, '') || ' ' || coalesce(content, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS chunks_search_vector_idx ON chunks USING gin (search_vector);

-- ── Lexical search over articles ─────────────────────────────────────────────
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS articles_search_vector_idx ON articles USING gin (search_vector);

-- ── Fuzzy lookups used by the agent workspace search box ─────────────────────
CREATE INDEX IF NOT EXISTS customers_display_name_trgm_idx
  ON customers USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_company_trgm_idx
  ON customers USING gin (company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contact_methods_normalized_trgm_idx
  ON contact_methods USING gin (normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tickets_subject_trgm_idx
  ON tickets USING gin (subject gin_trgm_ops);
CREATE INDEX IF NOT EXISTS conversations_subject_trgm_idx
  ON conversations USING gin (subject gin_trgm_ops);

-- ── Message body search, scoped per organization ─────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;
CREATE INDEX IF NOT EXISTS messages_search_vector_idx ON messages USING gin (search_vector);

-- ── Hot-path partial indexes ─────────────────────────────────────────────────
-- Queue polling and SLA sweeps both scan tiny slices of large tables.
CREATE INDEX IF NOT EXISTS conversations_open_idx
  ON conversations (organization_id, queue_id, created_at)
  WHERE status IN ('new', 'queued', 'assigned', 'active', 'waiting');

CREATE INDEX IF NOT EXISTS sla_clocks_running_idx
  ON sla_clocks (due_at)
  WHERE state = 'running';

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox_events (occurred_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS executions_resumable_idx
  ON executions (resume_after)
  WHERE status = 'suspended';
