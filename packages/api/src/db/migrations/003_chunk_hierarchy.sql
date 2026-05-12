-- 003_chunk_hierarchy.sql
-- Add position, section_title, section_path columns to chunks table
-- for neighbor-chunk queries and hierarchical section context.

-- New columns (all nullable for backward compatibility)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS position INTEGER;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_title TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_path TEXT;

-- Index for neighbor-chunk queries (find adjacent chunks by position)
CREATE INDEX IF NOT EXISTS idx_chunks_doc_position ON chunks(document_id, position);

-- Backfill from existing JSONB context
UPDATE chunks SET
  position = (context->>'positionInDocument')::integer,
  section_title = context->>'sectionName',
  section_path = context->>'sectionName'
WHERE position IS NULL;

-- Update BM25 trigger function to include section_title
CREATE OR REPLACE FUNCTION chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.section_title, '') || ' ' || NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to also fire on section_title changes
DROP TRIGGER IF EXISTS trg_chunks_search_vector ON chunks;
CREATE TRIGGER trg_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content, section_title ON chunks
  FOR EACH ROW EXECUTE FUNCTION chunks_search_vector_update();

-- Rebuild search_vector with section_title included
UPDATE chunks SET search_vector = to_tsvector('english', COALESCE(section_title, '') || ' ' || content);
