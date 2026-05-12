-- 010: Add provenance column for pipeline operation history
-- Append-only JSONB array tracking every operation on a document

ALTER TABLE documents ADD COLUMN provenance JSONB DEFAULT '[]';

-- GIN index for fast @> containment queries (e.g. find docs with specific op)
CREATE INDEX idx_documents_provenance ON documents USING GIN (provenance jsonb_path_ops);

-- Backfill: seed provenance for existing processed documents
UPDATE documents SET provenance = jsonb_build_array(jsonb_build_object(
  'op', 'ingest',
  'at', created_at,
  'commit', 'pre-provenance',
  'source_format', COALESCE(source_format, 'pdf')
))
WHERE status IN ('ready', 'failed', 'duplicate')
  AND (provenance IS NULL OR provenance = '[]'::jsonb);
