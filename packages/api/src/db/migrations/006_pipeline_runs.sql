-- Pipeline runs tracking table
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'running',
  direction TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'arxiv',
  categories TEXT[] NOT NULL,
  date_from TIMESTAMPTZ,
  date_to TIMESTAMPTZ,
  docs_fetched INT DEFAULT 0,
  docs_processed INT DEFAULT 0,
  docs_failed INT DEFAULT 0,
  docs_skipped INT DEFAULT 0,
  total_cost NUMERIC(10,4),
  metrics JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  last_processed_id TEXT
);

-- Seed record for existing papers
INSERT INTO pipeline_runs (status, direction, source, categories, docs_processed, finished_at)
VALUES ('completed', 'seed', 'arxiv', ARRAY['cs.AI','cs.CL','cs.LG'], 390, now());
