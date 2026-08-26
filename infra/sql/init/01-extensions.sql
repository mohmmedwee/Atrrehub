-- Extensions required by the Atrrehub platform.
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: RAG embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram similarity for fuzzy search
CREATE EXTENSION IF NOT EXISTS unaccent;    -- accent-insensitive text search
CREATE EXTENSION IF NOT EXISTS btree_gin;   -- composite GIN indexes
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
