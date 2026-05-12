-- 005: Add extracted_metadata column for chunking-time metadata extraction
ALTER TABLE documents ADD COLUMN extracted_metadata JSONB DEFAULT '{}';
