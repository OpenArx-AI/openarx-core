-- 021_source_registry_document_locations.sql
-- Multi-source document model: source registry + document locations.
-- Part of compliance epic openarx-7nv, task openarx-r7g.
--
-- source_registry: configuration per external source (arXiv, Unpaywall, etc.)
-- document_locations: all known locations/versions of a document across sources

-- ── Source registry ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS source_registry (
    source_id     VARCHAR(50) PRIMARY KEY,
    display_name  VARCHAR(200) NOT NULL,
    base_license  VARCHAR(100),          -- default license if document-level not available
    enabled       BOOLEAN NOT NULL DEFAULT true,
    config        JSONB NOT NULL DEFAULT '{}',  -- API endpoints, rate limits, extraction rules
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed known sources
INSERT INTO source_registry (source_id, display_name, base_license, config) VALUES
  ('arxiv',     'arXiv',                'LicenseRef-arxiv-nonexclusive', '{"api": "https://oaipmh.arxiv.org/oai", "rate_limit_ms": 3000}'),
  ('portal',    'OpenArx Portal',       NULL,                           '{"note": "author-selected license at publication"}'),
  ('unpaywall', 'Unpaywall',            NULL,                           '{"api": "https://api.unpaywall.org/v2", "rate_limit_day": 100000}'),
  ('openalex',  'OpenAlex',             NULL,                           '{"api": "https://api.openalex.org", "rate_limit_day": 100000}'),
  ('core',      'CORE',                 NULL,                           '{"api": "https://api.core.ac.uk/v3", "rate_limit_day": 10000}'),
  ('pmc',       'PubMed Central (PMC)', NULL,                           '{"api": "https://pmc.ncbi.nlm.nih.gov", "rate_limit_sec": 5}'),
  ('crossref',  'Crossref',             NULL,                           '{"api": "https://api.crossref.org"}')
ON CONFLICT (source_id) DO NOTHING;

-- ── Document locations ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS document_locations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source_id         VARCHAR(50) NOT NULL REFERENCES source_registry(source_id),
    source_identifier VARCHAR(500),        -- arxivId, pmcid, doi, openalex_id, etc.
    source_url        VARCHAR(1000),       -- direct URL to the resource
    license_raw       VARCHAR(500),        -- raw license string from source
    license_canonical VARCHAR(100),        -- normalized SPDX identifier
    license_source    VARCHAR(50) DEFAULT 'document',  -- 'document' | 'source_default' | 'unknown'
    version           VARCHAR(50),         -- 'preprint' | 'accepted' | 'published' | 'oa_copy'
    is_primary        BOOLEAN NOT NULL DEFAULT false,
    is_oa             BOOLEAN NOT NULL DEFAULT false,
    host_type         VARCHAR(50),         -- 'repository' | 'publisher' | 'aggregator'
    file_path         VARCHAR(1000),       -- local disk path if downloaded
    metadata          JSONB DEFAULT '{}',  -- source-specific extra data
    fetched_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup all locations for a document
CREATE INDEX idx_document_locations_doc ON document_locations(document_id);

-- Find primary location quickly
CREATE INDEX idx_document_locations_primary ON document_locations(document_id, is_primary) WHERE is_primary = true;

-- Filter by source
CREATE INDEX idx_document_locations_source ON document_locations(source_id);

-- Find OA locations with files (used by enrichment skip rule)
CREATE INDEX idx_document_locations_oa_file ON document_locations(document_id, is_oa, file_path, created_at)
  WHERE is_oa = true AND file_path IS NOT NULL;

-- Schema version tracking handled by migrate.ts runner
