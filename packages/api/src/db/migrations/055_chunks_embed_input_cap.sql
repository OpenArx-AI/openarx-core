-- 055_chunks_embed_input_cap.sql
-- Mark chunks whose EMBED INPUT was capped during the Stage-1 qwen re-embed
-- (epic openarx-lsqk / openarx-6d10; contracts §5 operational-policy cond-(d)).
-- Additive, forward-only, NO backfill in this migration (see below).
--
-- WHY: the bulk ran with `--max-embed-tokens 1024`, which truncates the INPUT handed to
-- the embedding model (never the stored text) to bound a long tail of ~13K-token chunks
-- that cost ~40x a normal chunk and starved the GPU. Contracts cond-(d) requires such
-- chunks be MARKED so a consumer can tell "this vector saw a truncated input" — the
-- stored content stays full, so the marking is fully reversible and 0 info-loss.
--
-- NULL = the embed input was NOT capped (the normal case).
-- 1024  = the input exceeded the cap and the model saw only its first 1024 tokens.
-- A nullable column add on chunks (~36M rows) is metadata-only in PostgreSQL: no table
-- rewrite, no default backfill, instant.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embed_input_cap_tokens integer;

-- Partial index so "which vectors saw a truncated input" is answerable cheaply; it stays
-- small (only capped rows, ~1% of the corpus). Plain (non-CONCURRENT) index: it indexes
-- only the rows the backfill marks, and the migration runs post-bulk.
-- (CONCURRENTLY cannot run inside a migration transaction.)
CREATE INDEX IF NOT EXISTS idx_chunks_embed_input_capped
  ON chunks (document_id)
  WHERE embed_input_cap_tokens IS NOT NULL;

-- THE MARKING ITSELF IS NOT DONE HERE, DELIBERATELY.
-- It is a conditional UPDATE over ~36M rows that must recompute each chunk's embed input
-- (title + section + optional [keyConcept] summary + content) to compare its length against
-- the cap. As one statement that is a multi-hour transaction holding row locks and bloating
-- the table. It runs instead as a resumable, batched backfill that commits per batch:
--
--   pnpm --filter @openarx/ingest run backfill-embed-cap -- --cap-tokens 1024
--
-- (packages/ingest/src/scripts/backfill-embed-cap.ts — same buildEmbedInput() the worker
-- used, so the reconstruction is byte-identical; safe to re-run, it only ever sets the
-- marker on rows that match.)
