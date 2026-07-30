#!/usr/bin/env node
/**
 * Reap orphaned presigned uploads (openarx-contracts-xuqi).
 *
 * Deletes portal_pending_uploads rows that were never consumed and are past
 * expiry + a 24h grace, and removes each row's staged file on disk. Consumed
 * uploads are NOT touched here — their staged file is removed at consume time
 * and the row is retained as a lightweight audit/idempotency record. Idempotent
 * and safe to run repeatedly.
 *
 * Run daily. Scheduling (systemd timer) is an OPS step that installs a system
 * unit — escalated to Vlad per the zero-third-party rule; this script itself is
 * npm-only and side-effect-bounded. See
 * deploy/systemd/openarx-pending-uploads-cleanup.{service,timer}.
 *
 *   node dist/scripts/cleanup-pending-uploads.js
 */
import { rm } from 'node:fs/promises';
import { query, pool } from '@openarx/api';
import { uploadFilePath } from '../lib/upload-paths.js';

async function main(): Promise<void> {
  const res = await query<{ file_id: string; user_id: string }>(
    `DELETE FROM portal_pending_uploads
      WHERE consumed_at IS NULL
        AND expires_at + interval '24 hours' < now()
      RETURNING file_id, user_id`,
  );
  let removedFiles = 0;
  for (const r of res.rows) {
    await rm(uploadFilePath(r.user_id, r.file_id), { force: true })
      .then(() => { removedFiles++; })
      .catch(() => { /* file may already be gone — row removal is the source of truth */ });
  }
  console.log(`[cleanup-pending-uploads] deleted ${res.rowCount ?? 0} orphan rows, removed ${removedFiles} staged files`);
  await pool.end();
}

main().catch((err) => {
  console.error('[cleanup-pending-uploads] failed:', err);
  process.exit(1);
});
