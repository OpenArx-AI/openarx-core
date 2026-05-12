/**
 * Soft-delete reconciliation loop — periodic PG ↔ Qdrant consistency.
 *
 * Spec: openarx-promo/docs/core_soft_delete_spec.md §7.1 (Qdrant
 * partial-failure recovery).
 *
 * PostgreSQL is the source of truth for `documents.deleted_at`. If an
 * admin delete/restore failed mid-way at the Qdrant step, the two sides
 * drift. This loop catches that drift every 5 minutes by comparing:
 *   - PG: documents where deleted_at IS NOT NULL (should be Qdrant-deleted)
 *   - Qdrant: per-doc count of points with deleted=false payload
 *
 * If a tombstoned doc still has non-deleted Qdrant points → flip them.
 * If a restored doc still has deleted Qdrant points → flip them back.
 *
 * Non-blocking: runs in a setInterval loop. Errors are logged but do not
 * crash the runner. Idempotent — re-entering on a fully-consistent state
 * is a no-op.
 */

import type { VectorStore } from '@openarx/types';
import { query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('soft-delete-reconcile');

const INTERVAL_MS = parseInt(process.env.SOFT_DELETE_RECONCILE_INTERVAL_MS ?? '300000', 10); // 5 min
const BATCH_LIMIT = parseInt(process.env.SOFT_DELETE_RECONCILE_BATCH ?? '200', 10);

export class ReconciliationLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private vectorStore: VectorStore;

  constructor(vectorStore: VectorStore) {
    this.vectorStore = vectorStore;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: INTERVAL_MS, batchLimit: BATCH_LIMIT }, 'reconciliation loop start');
    // Kick off the first tick after one interval — don't race with service startup.
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
    // unref so the loop doesn't block process exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests + manual trigger. Returns counts of drift found
   *  and corrected. */
  async tick(): Promise<{ toDeletedFixed: number; toActiveFixed: number; errors: number }> {
    if (this.running) {
      log.debug('reconciliation tick skipped — previous still running');
      return { toDeletedFixed: 0, toActiveFixed: 0, errors: 0 };
    }
    this.running = true;
    let toDeletedFixed = 0;
    let toActiveFixed = 0;
    let errors = 0;
    try {
      // Check the two drift directions. The SQL filters to a bounded
      // sample so a huge backlog doesn't hog Qdrant for minutes.
      toDeletedFixed = await this.reconcileDeleteDirection();
      toActiveFixed = await this.reconcileRestoreDirection();
      if (toDeletedFixed > 0 || toActiveFixed > 0) {
        log.info({ toDeletedFixed, toActiveFixed }, 'reconciliation tick completed');
      } else {
        log.debug('reconciliation tick: no drift');
      }
    } catch (err) {
      errors++;
      log.warn({ err: err instanceof Error ? err.message : err }, 'reconciliation tick error');
    } finally {
      this.running = false;
    }
    return { toDeletedFixed, toActiveFixed, errors };
  }

  /** Docs tombstoned in PG but their Qdrant points still say deleted=false.
   *  Flip Qdrant side to match. */
  private async reconcileDeleteDirection(): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `SELECT id::text AS id
       FROM documents
       WHERE deleted_at IS NOT NULL
       ORDER BY deleted_at DESC
       LIMIT $1`,
      [BATCH_LIMIT],
    );
    let fixed = 0;
    for (const row of rows) {
      try {
        // setDocumentDeleted is idempotent — if Qdrant already says
        // deleted=true, set_payload is a no-op but the count returned
        // includes matched points regardless. We compare against the
        // PG-known state: any points found → flip (no-op if already flipped).
        // To avoid spamming Qdrant we could pre-count, but the per-doc
        // cost is low; one extra set_payload per 5-min tick per deleted
        // doc is fine operationally.
        const n = await this.vectorStore.setDocumentDeleted(row.id, true);
        if (n > 0) fixed++;
      } catch (err) {
        log.warn(
          { docId: row.id, err: err instanceof Error ? err.message : err },
          'reconcile(delete): Qdrant flip failed',
        );
      }
    }
    return fixed;
  }

  /** Active PG docs that might still have Qdrant deleted=true payload.
   *  We scope to docs that were once deleted (have non-null
   *  deletion_reason but null deleted_at → recently restored). */
  private async reconcileRestoreDirection(): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `SELECT id::text AS id
       FROM documents
       WHERE deleted_at IS NULL
         AND deletion_reason IS NOT NULL
       ORDER BY id
       LIMIT $1`,
      [BATCH_LIMIT],
    );
    let fixed = 0;
    for (const row of rows) {
      try {
        const n = await this.vectorStore.setDocumentDeleted(row.id, false);
        if (n > 0) fixed++;
      } catch (err) {
        log.warn(
          { docId: row.id, err: err instanceof Error ? err.message : err },
          'reconcile(restore): Qdrant flip failed',
        );
      }
    }
    return fixed;
  }
}
