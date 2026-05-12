-- Compliance: mark existing arxiv docs as 'pending' for license backfill
-- Part of openarx-7nv epic. See docs/compliance_control_plane.md.
--
-- Migration 018 added indexing_tier with DEFAULT 'full', which backfilled all
-- existing documents to 'full'. We want to distinguish documents indexed BEFORE
-- license tracking existed from documents indexed AFTER.
--
-- 'pending' marks documents whose license is not yet determined. The doctor
-- backfill module (openarx-rfsj) will later extract licenses from arXiv
-- OAI-PMH for these and reclassify accordingly.
--
-- New documents from intake (after openarx-foo deployment) will have license
-- info from the start and should NOT be marked pending — they get 'full'
-- (or 'abstract_only' once openarx-bf0 implements the gate).

UPDATE documents
   SET indexing_tier = 'pending'
 WHERE source = 'arxiv'
   AND licenses = '{}'::jsonb;
