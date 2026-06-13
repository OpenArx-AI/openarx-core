-- 030: publisher attribution + idempotency for the unified publish-document
-- endpoint (openarx-contracts-uhlh, contract document_publication_pipeline.md
-- §8). Two columns:
--
--   publisher_user_id — the Portal user that submitted a source='portal' doc.
--     Until now the user was used only to build the storage path and never
--     persisted on the row. The contract scopes idempotency per user, and the
--     migrated layout drops the userId-in-path, so we persist it explicitly.
--     NULL for arxiv docs and legacy anonymous portal docs.
--
--   idempotency_key — optional client-supplied retry key. A retry with the
--     same (publisher_user_id, key) returns 409 idempotent_replay instead of
--     creating a second document.
--
-- Expiry is NOT a DB constraint (Postgres has no TTL on a unique index) — a
-- daily cleanup job NULLs keys older than 30 days so they can be reused. The
-- partial index covers only non-NULL keys, so cleared keys leave it entirely.
-- Per-user scoping holds because (publisher_user_id, idempotency_key) is the
-- index tuple: two users may reuse the same key without colliding.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS publisher_user_id UUID;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_idempotency_key
  ON documents (publisher_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN documents.idempotency_key IS
  'publish-document idempotency (uhlh §8). Scoped by publisher_user_id; '
  'NULLed after 30 days by the cleanup job so keys can be reused.';
