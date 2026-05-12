-- M1 Foundation: initial schema
-- Documents, chunks, and processing cost tracking

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  filename TEXT NOT NULL
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_version UUID REFERENCES documents(id),

  source VARCHAR(50) NOT NULL,
  source_id VARCHAR(100) NOT NULL,
  source_url TEXT,

  title TEXT NOT NULL,
  authors JSONB NOT NULL,
  abstract TEXT,
  categories TEXT[] NOT NULL,
  published_at TIMESTAMPTZ,

  raw_content_path TEXT,
  structured_content JSONB,

  code_links JSONB DEFAULT '[]',
  dataset_links JSONB DEFAULT '[]',
  benchmark_results JSONB DEFAULT '[]',

  status VARCHAR(20) NOT NULL DEFAULT 'downloaded',
  processing_log JSONB DEFAULT '[]',
  processing_cost NUMERIC(10,6) DEFAULT 0,

  UNIQUE(source, source_id, version)
);

CREATE INDEX idx_documents_source_id ON documents(source, source_id);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_categories ON documents USING GIN(categories);
CREATE INDEX idx_documents_published_at ON documents(published_at);

CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_version UUID REFERENCES chunks(id),

  document_id UUID NOT NULL REFERENCES documents(id),

  content TEXT NOT NULL,
  context JSONB NOT NULL,
  metrics JSONB DEFAULT '{}',

  qdrant_point_id UUID,

  UNIQUE(document_id, id, version)
);

CREATE INDEX idx_chunks_document_id ON chunks(document_id);

CREATE TABLE processing_costs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  document_id UUID REFERENCES documents(id),
  task VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost NUMERIC(10,6),
  duration_ms INTEGER
);

CREATE INDEX idx_costs_created_at ON processing_costs(created_at);
CREATE INDEX idx_costs_document_id ON processing_costs(document_id);
