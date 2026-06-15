-- documents.updated_at (openarx-contracts-amc7) — drives keyset pagination and
-- the `since` sync filter for GET /api/internal/user-documents.
--
-- Added nullable first (instant, no rewrite), backfilled to created_at, then
-- given a DEFAULT so new INSERTs are stamped. A BEFORE UPDATE trigger keeps it
-- current on every row change (status transitions, metadata edits) — that is
-- exactly the signal Portal pulls on to detect changed docs.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE documents SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE documents ALTER COLUMN updated_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION documents_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_set_updated_at();

-- Keyset pagination index: per-user, newest-first, active docs only.
CREATE INDEX IF NOT EXISTS idx_documents_user_updated
  ON documents (publisher_user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN documents.updated_at IS
  'Last row modification (maintained by trg_documents_updated_at). Drives '
  'GET /api/internal/user-documents pagination + since filter (amc7).';
