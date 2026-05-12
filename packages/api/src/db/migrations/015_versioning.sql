-- F3: Document Versioning Support
-- Adds concept_id to documents (groups versions of same paper)
-- Adds is_latest to chunks (for version-aware search filtering)

-- concept_id: groups all versions of the same paper
-- For arXiv papers: concept_id = id (each paper is its own concept, until Portal creates versions)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS concept_id UUID;

-- Backfill: every existing document is its own concept (single version)
UPDATE documents SET concept_id = id WHERE concept_id IS NULL;

-- Index for querying all versions of a concept
CREATE INDEX IF NOT EXISTS idx_documents_concept_id ON documents(concept_id);

-- is_latest on chunks: search only returns latest version's chunks
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;

-- Partial index: only used in WHERE is_latest = TRUE queries
CREATE INDEX IF NOT EXISTS idx_chunks_is_latest ON chunks(is_latest) WHERE is_latest = TRUE;
