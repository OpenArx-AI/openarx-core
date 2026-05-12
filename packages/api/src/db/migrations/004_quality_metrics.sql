-- M4 Quality Metrics: parse quality scoring on documents
-- Computed after indexing to identify problematic parses

ALTER TABLE documents ADD COLUMN parse_quality NUMERIC(4,3);
ALTER TABLE documents ADD COLUMN math_density NUMERIC(4,3);
ALTER TABLE documents ADD COLUMN parser_used VARCHAR(20);
ALTER TABLE documents ADD COLUMN quality_flags JSONB DEFAULT '{}';
