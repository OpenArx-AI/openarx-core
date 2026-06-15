-- Presigned upload staging for MCP publishing (openarx-contracts-xuqi).
--
-- Flow: create_upload_url mints a row → PUT /api/upload/{file_id} fills it
-- (filled_at, size_bytes) → submit_document/create_new_version consumes it via
-- content_ref (consumed_at). Orphans (never consumed, past expiry + 24h grace)
-- are reaped by the cleanup-pending-uploads job. Same Core DB as `documents`.
--
-- expected_content_type / expected_size_bytes are the optional hints supplied
-- to create_upload_url; the PUT handler enforces the declared content type's
-- magic bytes when expected_content_type is set.

CREATE TABLE IF NOT EXISTS portal_pending_uploads (
  file_id               UUID PRIMARY KEY,
  user_id               UUID NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  filled_at             TIMESTAMPTZ,
  size_bytes            BIGINT,
  consumed_at           TIMESTAMPTZ,
  expected_content_type TEXT,
  expected_size_bytes   BIGINT
);

-- Drives the cleanup sweep: only unconsumed rows can become orphans.
CREATE INDEX IF NOT EXISTS idx_pending_uploads_expires
  ON portal_pending_uploads (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE portal_pending_uploads IS
  'Presigned upload staging for MCP publishing (openarx-contracts-xuqi). '
  'Minted by create_upload_url, filled by PUT /api/upload/{file_id}, '
  'consumed by submit_document/create_new_version via content_ref.';
