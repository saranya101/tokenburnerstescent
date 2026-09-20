CREATE EXTENSION IF NOT EXISTS vector;

-- Prisma cannot yet manage all pgvector index features. Apply an HNSW/IVFFlat index
-- separately once the embedding model and dimensionality are stable.
