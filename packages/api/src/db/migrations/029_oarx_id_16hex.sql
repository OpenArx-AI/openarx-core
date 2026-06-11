-- 029: Widen oarx_id from 8 to 16 hex chars (openarx-pc98)
--
-- Old format: oarx-{8 hex}  = 13 chars (32 bits) — collided at ~1M docs
--             (33 real pairs hit during the 2025 registry backfill).
-- New format: oarx-{16 hex} = 21 chars (64 bits) — collisions negligible
--             at any realistic corpus size.
--
-- Same derivation: sha256('<source>:<source_id>'), longer slice — so the
-- OLD id is a PREFIX of the NEW id. The old value is preserved in
-- external_ids.oarx_legacy; an expression index on left(oarx_id, 13)
-- serves legacy lookups (ambiguous only for the ~85 legacy collision
-- pairs, which is inherent to the 32-bit form).
--
-- Run with the pipeline runner IDLE: updates every row of documents.

-- Safety check: the formula must reproduce every existing oarx_id as its
-- 13-char prefix. If any row mismatches, the derivation assumption is
-- wrong for it — abort before touching data.
DO $$
DECLARE mismatched INTEGER;
BEGIN
  SELECT count(*) INTO mismatched FROM documents
  WHERE oarx_id IS NOT NULL
    AND oarx_id != 'oarx-' || left(encode(sha256(convert_to(source || ':' || source_id, 'UTF8')), 'hex'), 8);
  IF mismatched > 0 THEN
    RAISE EXCEPTION '029 aborted: % documents have oarx_id not derivable from source:source_id — investigate before widening', mismatched;
  END IF;
END $$;

ALTER TABLE documents ALTER COLUMN oarx_id TYPE VARCHAR(21);

-- Regenerate: keep the legacy id in external_ids.oarx_legacy, write the
-- 16-hex id into both the column and external_ids.oarx.
UPDATE documents
SET external_ids = jsonb_set(
      jsonb_set(coalesce(external_ids, '{}'::jsonb), '{oarx_legacy}', to_jsonb(oarx_id)),
      '{oarx}',
      to_jsonb('oarx-' || left(encode(sha256(convert_to(source || ':' || source_id, 'UTF8')), 'hex'), 16))
    ),
    oarx_id = 'oarx-' || left(encode(sha256(convert_to(source || ':' || source_id, 'UTF8')), 'hex'), 16)
WHERE oarx_id IS NOT NULL AND length(oarx_id) = 13;

-- Legacy lookup: resolve old 13-char ids via prefix (same sha256).
CREATE INDEX IF NOT EXISTS idx_documents_oarx_legacy ON documents (left(oarx_id, 13)) WHERE oarx_id IS NOT NULL;

-- Post-check: widening must leave zero duplicates (64-bit space) and zero
-- legacy-length values.
DO $$
DECLARE dup INTEGER; legacy INTEGER;
BEGIN
  SELECT count(*) - count(DISTINCT oarx_id) INTO dup FROM documents WHERE oarx_id IS NOT NULL;
  SELECT count(*) INTO legacy FROM documents WHERE oarx_id IS NOT NULL AND length(oarx_id) != 21;
  IF dup > 0 OR legacy > 0 THEN
    RAISE EXCEPTION '029 post-check failed: % duplicate oarx_id, % non-21-char values', dup, legacy;
  END IF;
END $$;
