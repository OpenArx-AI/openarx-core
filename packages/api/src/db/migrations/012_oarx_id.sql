-- 012: Add oarx_id column — short human-readable document identifier
-- Format: oarx-{8 hex chars} derived from SHA-256(source:source_id)

ALTER TABLE documents ADD COLUMN oarx_id VARCHAR(13);

CREATE UNIQUE INDEX idx_documents_oarx_id ON documents (oarx_id) WHERE oarx_id IS NOT NULL;

-- Backfill existing documents
UPDATE documents
SET oarx_id = 'oarx-' || left(encode(sha256(convert_to(source || ':' || source_id, 'UTF8')), 'hex'), 8)
WHERE oarx_id IS NULL;
