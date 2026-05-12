-- 011: Add external_ids JSONB for DOI, Semantic Scholar, OpenAlex, etc.
-- Example: {"doi": "10.1234/...", "s2_id": "abc123", "dblp": "journals/corr/...", "openalex": "W123"}

ALTER TABLE documents ADD COLUMN external_ids JSONB DEFAULT '{}';

CREATE INDEX idx_documents_external_ids ON documents USING GIN (external_ids jsonb_path_ops);
