/**
 * Append-only writer + readers for `document_audit_log` (migration 027).
 *
 * Spec: openarx-promo/docs/core_soft_delete_spec.md §4.2.
 * Every soft-delete, restore, and rate-limited ingest_skip writes a row.
 * Application-layer enforces append-only — no DELETE method lives here.
 */

import type { DeletionReason, DocumentAuditEntry } from '@openarx/types';
import { query } from '../db/pool.js';

export type AuditAction = 'delete' | 'restore' | 'ingest_skip' | 'memo_update';

export interface AppendAuditInput {
  documentId: string;
  action: AuditAction;
  actor: string;
  reason?: DeletionReason | null;
  memo?: string | null;
  noticeRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AuditRow {
  id: string;
  document_id: string;
  action: string;
  actor: string;
  reason: string | null;
  memo: string | null;
  notice_ref: string | null;
  metadata: unknown;
  created_at: Date;
}

function rowToEntry(row: AuditRow): DocumentAuditEntry {
  return {
    id: Number(row.id),
    documentId: row.document_id,
    action: row.action as DocumentAuditEntry['action'],
    actor: row.actor,
    reason: (row.reason as DeletionReason | null) ?? null,
    memo: row.memo,
    noticeRef: row.notice_ref,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.created_at,
  };
}

/** Append one audit entry. Returns the auto-generated id. */
export async function appendAuditEntry(input: AppendAuditInput): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO document_audit_log
       (document_id, action, actor, reason, memo, notice_ref, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id::text AS id`,
    [
      input.documentId,
      input.action,
      input.actor,
      input.reason ?? null,
      input.memo ?? null,
      input.noticeRef ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return Number(r.rows[0]!.id);
}

/** Return audit entries for a document, most recent first (for the
 *  admin UI and DMCA §4.3 rightsholder log-access). */
export async function getAuditEntriesForDocument(
  documentId: string,
  limit: number = 200,
): Promise<DocumentAuditEntry[]> {
  const r = await query<AuditRow>(
    `SELECT id::text AS id, document_id::text AS document_id, action, actor,
            reason, memo, notice_ref, metadata, created_at
     FROM document_audit_log
     WHERE document_id = $1::uuid
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [documentId, limit],
  );
  return r.rows.map(rowToEntry);
}
