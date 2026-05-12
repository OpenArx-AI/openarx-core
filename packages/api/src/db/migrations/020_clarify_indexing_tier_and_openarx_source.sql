-- Compliance: clarify indexing_tier semantics + rename manual → openarx source
-- Part of openarx-7nv epic. See docs/compliance_control_plane.md.
--
-- Two clarifications:
--
-- 1. indexing_tier reflects PROCESSING DEPTH (how much of the doc is in the
--    index), not license determination state. Existing 108K arxiv docs ARE
--    fully indexed (chunks + embeddings + everything), so they should be
--    'full', not 'pending'. License determination is a separate concern,
--    identified by `licenses = '{}'::jsonb` (empty multi-source map).
--    Migration 019 incorrectly conflated these two concepts — this migration
--    reverts that change.
--
-- 2. The 'pending' value in indexing_tier was redundant — race protection is
--    already handled by documents.status (downloaded/processing/ready/failed).
--    Removed from the CHECK constraint.
--
-- 3. The license source 'manual' was a misnomer for documents published via
--    OpenArx Portal. OpenArx is itself a document source (like arxiv, pmc),
--    not a manual admin override. Renamed 'manual' → 'openarx' in the
--    licenses JSONB.

-- ── 1. Revert indexing_tier 'pending' → 'full' ──────────────
-- Existing docs are fully indexed, just lacking license info.
UPDATE documents SET indexing_tier = 'full' WHERE indexing_tier = 'pending';

-- ── 2. Drop 'pending' from CHECK constraint ─────────────────
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_indexing_tier_check;
ALTER TABLE documents ADD CONSTRAINT documents_indexing_tier_check
  CHECK (indexing_tier IN ('full', 'abstract_only'));

-- ── 3. Rename 'manual' → 'openarx' in licenses JSONB ───────
-- Affects portal-published documents that were backfilled in migration 018.
UPDATE documents
   SET licenses = jsonb_build_object('openarx', licenses->>'manual')
 WHERE licenses ? 'manual';
