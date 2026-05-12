-- 027: Document soft-delete — tombstone fields + audit log
--
-- Implements core_soft_delete_spec.md §4. Additive, backward-compatible:
-- existing documents default to deleted_at=NULL (active). No data backfill
-- required for PG; Qdrant backfill is a separate step (see
-- scripts/qdrant-backfill-deleted.ts) that must run before the search
-- filter is deployed (spec §10.1).

-- ─── documents: tombstone fields ──────────────────────────

ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(64) NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deletion_memo TEXT NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(255) NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deletion_notice_ref VARCHAR(255) NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

-- Partial indexes (spec §4.1). "Active" index speeds up the common path
-- — join on documents filtered to deleted_at IS NULL. "Deleted" index
-- serves the admin list endpoint GET /admin/documents/deleted.
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_active
  ON documents (id)
  WHERE deleted_at IS NULL;

-- ─── document_audit_log ───────────────────────────────────

CREATE TABLE IF NOT EXISTS document_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    document_id     UUID NOT NULL REFERENCES documents(id),
    action          VARCHAR(32) NOT NULL,    -- 'delete' | 'restore' | 'ingest_skip' | 'memo_update'
    actor           VARCHAR(255) NOT NULL,
    reason          VARCHAR(64) NULL,
    memo            TEXT NULL,
    notice_ref      VARCHAR(255) NULL,
    metadata        JSONB NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_audit_doc_id
  ON document_audit_log (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_doc_audit_action
  ON document_audit_log (action, created_at DESC);

-- Append-only enforcement lives in app code convention. No DELETE grant
-- added here; whoever calls UPDATE/DELETE would need the table owner
-- privilege. Documented in core_soft_delete_spec.md §4.2.
