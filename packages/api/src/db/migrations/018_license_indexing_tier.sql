-- Compliance: license multi-source storage + indexing tier
-- Part of openarx-7nv epic. See docs/compliance_control_plane.md.
--
-- Adds:
--   - documents.licenses JSONB — multi-source license map { source_id: SPDX, ... }
--   - documents.indexing_tier — 'full' / 'abstract_only' / 'pending'
--   - coverage_map.breakdown — JSONB with license + processing distribution per day
-- Modifies:
--   - documents.license — expanded VARCHAR(30) → VARCHAR(50) for LicenseRef-* SPDX values
--   - existing portal license values normalized to SPDX format

-- ── 1. Expand license column for LicenseRef-* identifiers ────
-- LicenseRef-arxiv-nonexclusive is 31 chars, doesn't fit in VARCHAR(30)
ALTER TABLE documents ALTER COLUMN license TYPE VARCHAR(50);

-- ── 2. Normalize existing portal license values to SPDX ─────
-- Portal flow currently stores lowercase strings like 'cc-by-4.0'.
-- Convert them to SPDX format (CC-BY-4.0).
UPDATE documents SET license = 'CC-BY-4.0'           WHERE license = 'cc-by-4.0';
UPDATE documents SET license = 'CC-BY-SA-4.0'        WHERE license = 'cc-by-sa-4.0';
UPDATE documents SET license = 'CC-BY-NC-4.0'        WHERE license = 'cc-by-nc-4.0';
UPDATE documents SET license = 'CC-BY-NC-SA-4.0'     WHERE license = 'cc-by-nc-sa-4.0';
UPDATE documents SET license = 'CC-BY-NC-ND-4.0'     WHERE license = 'cc-by-nc-nd-4.0';
UPDATE documents SET license = 'CC-BY-ND-4.0'        WHERE license = 'cc-by-nd-4.0';
UPDATE documents SET license = 'CC0-1.0'             WHERE license IN ('cc0', 'cc0-1.0');

-- ── 3. Multi-source licenses JSONB ──────────────────────────
-- Stores { 'arxiv_oai': 'CC-BY-4.0', 'crossref': 'CC-BY-4.0', 'manual': 'CC0-1.0', ... }
-- Each source contributes its own SPDX value; the canonical 'license' column is
-- computed from this map by application code (computeEffectiveLicense helper).
ALTER TABLE documents ADD COLUMN licenses JSONB DEFAULT '{}';

-- Backfill licenses JSONB for the existing portal doc.
-- NOTE: This initially stored 'manual' as the source key, but migration 020
-- renames it to 'openarx' (Portal-published documents come from the OpenArx
-- source, not from manual admin override).
UPDATE documents
   SET licenses = jsonb_build_object('manual', license)
 WHERE source = 'portal' AND license IS NOT NULL;

-- ── 4. Indexing tier ────────────────────────────────────────
-- 'full' = chunked + embedded normally (default for backwards compat)
-- 'abstract_only' = lightweight indexing for restricted-license documents
-- 'pending' = in-flight processing (race protection)
ALTER TABLE documents ADD COLUMN indexing_tier VARCHAR(20) DEFAULT 'full'
  CHECK (indexing_tier IN ('full', 'abstract_only', 'pending'));

-- ── 5. Indexes ──────────────────────────────────────────────
-- license index already exists from migration 016 (idx_documents_license)
CREATE INDEX IF NOT EXISTS idx_documents_indexing_tier
  ON documents(indexing_tier);

CREATE INDEX IF NOT EXISTS idx_documents_licenses_gin
  ON documents USING gin(licenses);

-- ── 6. Coverage map breakdown ───────────────────────────────
-- Per-day distribution of licenses + processing tiers for visibility on coverage UI.
-- Structure:
--   { "licenses": { "CC-BY-4.0": 45, "LicenseRef-arxiv-nonexclusive": 180 },
--     "processing": { "full": 57, "abstract_only": 180, "failed": 0 } }
ALTER TABLE coverage_map ADD COLUMN breakdown JSONB DEFAULT '{}';
