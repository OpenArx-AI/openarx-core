-- Add denormalized document metadata to chunks for BM25 search
-- Enables search by author name, paper title, and arXiv ID

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS document_title TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS document_source_id TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS document_authors_text TEXT;

-- Update trigger to include metadata in search_vector
CREATE OR REPLACE FUNCTION chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.document_title, '') || ' ' ||
    COALESCE(NEW.document_source_id, '') || ' ' ||
    COALESCE(NEW.document_authors_text, '') || ' ' ||
    COALESCE(NEW.section_title, '') || ' ' ||
    NEW.content
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger to fire on new columns too
DROP TRIGGER IF EXISTS trg_chunks_search_vector ON chunks;
CREATE TRIGGER trg_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content, section_title, document_title, document_source_id, document_authors_text
  ON chunks FOR EACH ROW EXECUTE FUNCTION chunks_search_vector_update();

-- Backfill existing chunks (trigger fires automatically, rebuilding search_vector)
UPDATE chunks SET
  document_title = d.title,
  document_source_id = d.source_id,
  document_authors_text = (
    SELECT string_agg(author->>'name', ', ')
    FROM jsonb_array_elements(d.authors) AS author
  )
FROM documents d
WHERE chunks.document_id = d.id;
