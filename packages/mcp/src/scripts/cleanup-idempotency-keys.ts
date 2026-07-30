#!/usr/bin/env node
/**
 * Expire publish-document idempotency keys older than 30 days
 * (contract document_publication_pipeline.md §8, bead openarx-contracts-uhlh).
 * Postgres has no TTL on a unique index, so we NULL aged keys to free them
 * for reuse. Idempotent and safe to run repeatedly.
 *
 * Run daily. Scheduling (systemd timer / cron) is an OPS step that installs a
 * system daemon — escalated to Vlad per the zero-third-party rule; this
 * script itself is npm-only and side-effect-bounded.
 *
 *   node dist/scripts/cleanup-idempotency-keys.js
 */
import { query, pool } from '@openarx/api';

async function main(): Promise<void> {
  const res = await query<{ id: string }>(
    `UPDATE documents
        SET idempotency_key = NULL
      WHERE idempotency_key IS NOT NULL
        AND created_at < now() - interval '30 days'
      RETURNING id`,
  );
  console.log(`[cleanup-idempotency-keys] cleared ${res.rowCount ?? 0} expired keys`);
  await pool.end();
}

main().catch((err) => { console.error('[cleanup-idempotency-keys] failed:', err); process.exit(1); });
