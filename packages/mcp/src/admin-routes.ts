/**
 * Admin API — soft-delete + audit endpoints.
 *
 * Spec: openarx-promo/docs/core_soft_delete_spec.md §7.
 * Contract: contracts/document_soft_delete.md §6.
 *
 * Auth: Bearer token via ADMIN_API_TOKEN env var. Separate from
 * CORE_INTERNAL_SECRET so rotation / audit can be scoped to "admin" vs
 * "internal service-to-service".
 *
 * Endpoints:
 *   POST /admin/documents/:id/delete
 *   POST /admin/documents/:id/restore
 *   GET  /admin/documents/deleted
 *   GET  /admin/documents/:id
 *   GET  /admin/documents/:id/audit
 */

import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import {
  softDeleteDocument,
  restoreDocument,
  getDocumentForAdmin,
  listDeletedDocuments,
  appendAuditEntry,
  getAuditEntriesForDocument,
  AlreadyDeletedError,
  NotDeletedError,
  DocumentNotFoundError,
  query,
} from '@openarx/api';
import type { DeletionReason } from '@openarx/types';
import type { AppContext } from './context.js';

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

const ALLOWED_REASONS: ReadonlySet<DeletionReason> = new Set([
  'dmca', 'tos_violation', 'author_request', 'quality', 'legal_other', 'operator',
]);

function isAllowedReason(v: unknown): v is DeletionReason {
  return typeof v === 'string' && ALLOWED_REASONS.has(v as DeletionReason);
}

/** Bearer-token middleware. 401 with empty body on miss — no info leak.
 *  ADMIN_API_TOKEN env var must be set at startup. If unset, every call
 *  returns 401 (fail-closed). */
function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!ADMIN_TOKEN) {
    res.status(401).end();
    return;
  }
  if (typeof header !== 'string') {
    res.status(401).end();
    return;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match || match[1] !== ADMIN_TOKEN) {
    res.status(401).end();
    return;
  }
  next();
}

export function registerAdminRoutes(app: Express, ctx: AppContext): void {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAdminAuth);

  // ─── POST /admin/documents/:id/delete ─────────────────────
  router.post('/documents/:id/delete', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.id ?? '');
      if (!documentId) {
        res.status(400).json({ error: 'validation_error', message: 'documentId required' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = body.reason;
      if (!isAllowedReason(reason)) {
        res.status(400).json({
          error: 'validation_error',
          message: `reason must be one of: ${[...ALLOWED_REASONS].join(', ')}`,
        });
        return;
      }
      const actor = typeof body.actor === 'string' && body.actor.length > 0
        ? body.actor
        : 'admin-api';
      const memo = typeof body.memo === 'string' ? body.memo : null;
      const noticeRef = typeof body.notice_ref === 'string' ? body.notice_ref : null;

      // 1. PostgreSQL: atomic soft-delete (source of truth).
      const pgResult = await softDeleteDocument({
        documentId, reason, memo, noticeRef, actor,
      });

      // 2. Qdrant: flip all points. On failure PG stays deleted, reconciliation
      //    loop (PR6) retries. Return 500 with partial-failure so operator knows.
      let qdrantCount = 0;
      let qdrantFailed = false;
      let qdrantErrMsg: string | undefined;
      try {
        qdrantCount = await ctx.vectorStore.setDocumentDeleted(documentId, true);
      } catch (err) {
        qdrantFailed = true;
        qdrantErrMsg = err instanceof Error ? err.message : String(err);
        console.error(`[admin] qdrant set_payload failed for ${documentId}: ${qdrantErrMsg}`);
      }

      // 3. Audit log — write regardless of Qdrant success (PG is SOT).
      const auditId = await appendAuditEntry({
        documentId,
        action: 'delete',
        actor,
        reason,
        memo,
        noticeRef,
        metadata: qdrantFailed
          ? { qdrant_sync_failed: true, qdrant_error: qdrantErrMsg }
          : { qdrant_points_marked: qdrantCount },
      });

      if (qdrantFailed) {
        res.status(500).json({
          error: 'qdrant_partial_failure',
          message: 'PostgreSQL deleted, Qdrant sync failed — reconciliation will retry',
          document_id: documentId,
          deleted_at: pgResult.deletedAt,
          chunks_marked: pgResult.chunksCount,
          qdrant_points_marked: 0,
          qdrant_error: qdrantErrMsg,
          audit_log_id: auditId,
        });
        return;
      }

      res.status(200).json({
        document_id: documentId,
        deleted_at: pgResult.deletedAt,
        reason,
        chunks_marked: pgResult.chunksCount,
        qdrant_points_marked: qdrantCount,
        audit_log_id: auditId,
      });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (err instanceof AlreadyDeletedError) {
        res.status(409).json({
          error: 'already_deleted',
          deleted_at: err.deletedAt,
          reason: err.reason,
        });
        return;
      }
      console.error('[admin] delete error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ─── POST /admin/documents/:id/restore ────────────────────
  router.post('/documents/:id/restore', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.id ?? '');
      if (!documentId) {
        res.status(400).json({ error: 'validation_error', message: 'documentId required' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actor = typeof body.actor === 'string' && body.actor.length > 0
        ? body.actor
        : 'admin-api';
      const memo = typeof body.memo === 'string' ? body.memo : null;

      const pgResult = await restoreDocument({ documentId, memo, actor });

      let qdrantCount = 0;
      let qdrantFailed = false;
      let qdrantErrMsg: string | undefined;
      try {
        qdrantCount = await ctx.vectorStore.setDocumentDeleted(documentId, false);
      } catch (err) {
        qdrantFailed = true;
        qdrantErrMsg = err instanceof Error ? err.message : String(err);
        console.error(`[admin] qdrant restore failed for ${documentId}: ${qdrantErrMsg}`);
      }

      const auditId = await appendAuditEntry({
        documentId,
        action: 'restore',
        actor,
        memo,
        metadata: qdrantFailed
          ? { qdrant_sync_failed: true, qdrant_error: qdrantErrMsg }
          : { qdrant_points_unmarked: qdrantCount },
      });

      if (qdrantFailed) {
        res.status(500).json({
          error: 'qdrant_partial_failure',
          message: 'PostgreSQL restored, Qdrant sync failed — reconciliation will retry',
          document_id: documentId,
          restored_at: pgResult.restoredAt,
          previous_deletion_reason: pgResult.previousDeletionReason,
          chunks_unmarked: pgResult.chunksCount,
          qdrant_points_unmarked: 0,
          qdrant_error: qdrantErrMsg,
          audit_log_id: auditId,
        });
        return;
      }

      res.status(200).json({
        document_id: documentId,
        restored_at: pgResult.restoredAt,
        previous_deletion_reason: pgResult.previousDeletionReason,
        chunks_unmarked: pgResult.chunksCount,
        qdrant_points_unmarked: qdrantCount,
        audit_log_id: auditId,
      });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (err instanceof NotDeletedError) {
        res.status(409).json({ error: 'not_deleted' });
        return;
      }
      console.error('[admin] restore error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ─── GET /admin/documents/deleted ─────────────────────────
  router.get('/documents/deleted', async (req: Request, res: Response) => {
    try {
      const since = typeof req.query.since === 'string' ? new Date(req.query.since) : undefined;
      const until = typeof req.query.until === 'string' ? new Date(req.query.until) : undefined;
      const reason = isAllowedReason(req.query.reason) ? req.query.reason : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;

      const result = await listDeletedDocuments({ since, until, reason, limit, offset });
      res.status(200).json({
        items: result.items.map((d) => ({
          document_id: d.documentId,
          title: d.title,
          source: d.source,
          source_id: d.sourceId,
          deleted_at: d.deletedAt,
          reason: d.deletionReason,
          memo: d.deletionMemo,
          notice_ref: d.deletionNoticeRef,
          deleted_by: d.deletedBy,
          last_seen_at: d.lastSeenAt,
        })),
        total: result.total,
        next_offset: result.nextOffset,
      });
    } catch (err) {
      console.error('[admin] list deleted error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ─── GET /admin/documents/:id ─────────────────────────────
  router.get('/documents/:id', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.id ?? '');
      const doc = await getDocumentForAdmin(documentId);
      if (!doc) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Chunk count for operator visibility (spec §7.3).
      const { rows } = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM chunks WHERE document_id = $1::uuid`,
        [documentId],
      );
      res.status(200).json({
        id: doc.documentId,
        title: doc.title,
        source: doc.source,
        source_id: doc.sourceId,
        external_ids: doc.externalIds,
        deleted_at: doc.deletedAt,
        deletion_reason: doc.deletionReason,
        deletion_memo: doc.deletionMemo,
        deleted_by: doc.deletedBy,
        deletion_notice_ref: doc.deletionNoticeRef,
        last_seen_at: doc.lastSeenAt,
        created_at: doc.createdAt,
        chunks_count: parseInt(rows[0]?.cnt ?? '0', 10),
      });
    } catch (err) {
      console.error('[admin] get error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ─── GET /admin/documents/:id/audit ───────────────────────
  router.get('/documents/:id/audit', async (req: Request, res: Response) => {
    try {
      const documentId = String(req.params.id ?? '');
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 200;
      const entries = await getAuditEntriesForDocument(documentId, limit);
      res.status(200).json({
        items: entries.map((e) => ({
          audit_log_id: e.id,
          document_id: e.documentId,
          action: e.action,
          actor: e.actor,
          reason: e.reason,
          memo: e.memo,
          notice_ref: e.noticeRef,
          metadata: e.metadata,
          created_at: e.createdAt,
        })),
      });
    } catch (err) {
      console.error('[admin] audit error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.use('/admin', router);
}
