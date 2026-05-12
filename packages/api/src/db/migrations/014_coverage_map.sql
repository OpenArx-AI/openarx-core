-- 014: Coverage map — tracks ingestion completeness per source/category/date

CREATE TABLE coverage_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,
  category VARCHAR(100) NOT NULL,
  date DATE NOT NULL,
  expected INT,
  actual INT DEFAULT 0,
  download_failed INT DEFAULT 0,
  skipped INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'not_started',
  last_checked_at TIMESTAMPTZ,
  UNIQUE(source, category, date)
);

CREATE INDEX idx_coverage_status ON coverage_map (source, status, date);

-- Backfill from existing documents
INSERT INTO coverage_map (source, category, date, actual, status, last_checked_at)
SELECT 'arxiv', 'cs.AI,cs.CL,cs.LG', published_at::date, count(*), 'complete', now()
FROM documents
WHERE status = 'ready' AND published_at >= '2026-01-01'
GROUP BY published_at::date
ON CONFLICT DO NOTHING;
