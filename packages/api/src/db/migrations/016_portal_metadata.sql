-- F3 Phase 4: Portal document metadata fields
-- Supports user-submitted documents via POST /api/internal/ingest-document

-- Filterable dedicated columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS license VARCHAR(30);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS keywords TEXT[];
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS resource_type VARCHAR(30) DEFAULT 'preprint';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embargo_until TIMESTAMPTZ;

-- Flexible JSONB for rarely-queried Portal metadata
-- Stores: funding, coi_statement, data_availability, data_availability_url, related_identifiers
ALTER TABLE documents ADD COLUMN IF NOT EXISTS portal_metadata JSONB DEFAULT '{}';

-- Indexes for filterable fields
CREATE INDEX IF NOT EXISTS idx_documents_keywords ON documents USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_documents_license ON documents(license) WHERE license IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_resource_type ON documents(resource_type);
CREATE INDEX IF NOT EXISTS idx_documents_embargo ON documents(embargo_until) WHERE embargo_until IS NOT NULL;
