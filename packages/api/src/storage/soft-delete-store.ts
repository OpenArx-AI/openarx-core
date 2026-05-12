/**
 * Soft-delete operations on the documents table.
 *
 * Spec: openarx-promo/docs/core_soft_delete_spec.md §4, §7.
 *
 * PostgreSQL is the source of truth for deletion state. Qdrant sync is
 * done by the caller after the PG transaction commits. If Qdrant fails,
 * the reconciliation loop (PR6) picks up the drift.
 */

import type { DeletionReason } from '@openarx/types';
import { query, pool } from '../db/pool.js';

export interface SoftDeleteInput {
  documentId: string;
  reason: DeletionReason;
  memo?: string | null;
  noticeRef?: string | null;
  actor: string;
}

export interface SoftDeleteResult {
  documentId: string;
  deletedAt: Date;
  reason: DeletionReason;
  chunksCount: number;
}

export interface RestoreInput {
  documentId: string;
  memo?: string | null;
  actor: string;
}

export interface RestoreResult {
  documentId: string;
  restoredAt: Date;
  previousDeletionReason: DeletionReason | null;
  chunksCount: number;
}

interface DocDeletionStateRow {
  id: string;
  deleted_at: Date | null;
  deletion_reason: string | null;
}

class AlreadyDeletedError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly deletedAt: Date,
    public readonly reason: string | null,
  ) {
    super(`document ${documentId} already deleted at ${deletedAt.toISOString()}`);
    this.name = 'AlreadyDeletedError';
  }
}

class NotDeletedError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} is not currently deleted`);
    this.name = 'NotDeletedError';
  }
}

class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}

export { AlreadyDeletedError, NotDeletedError, DocumentNotFoundError };

async function countChunks(documentId: string): Promise<number> {
  const r = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM chunks WHERE document_id = $1::uuid`,
    [documentId],
  );
  return parseInt(r.rows[0]?.cnt ?? '0', 10);
}

/** Atomically flip the deletion state fields on the document. Throws
 *  typed errors so the HTTP layer can map to 404/409. */
export async function softDeleteDocument(input: SoftDeleteInput): Promise<SoftDeleteResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<DocDeletionStateRow>(
      `SELECT id::text AS id, deleted_at, deletion_reason
       FROM documents
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.documentId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new DocumentNotFoundError(input.documentId);
    }
    const row = existing.rows[0]!;
    if (row.deleted_at) {
      await client.query('ROLLBACK');
      throw new AlreadyDeletedError(input.documentId, row.deleted_at, row.deletion_reason);
    }
    const updated = await client.query<{ deleted_at: Date }>(
      `UPDATE documents
       SET deleted_at = NOW(),
           deletion_reason = $2,
           deletion_memo = $3,
           deleted_by = $4,
           deletion_notice_ref = $5
       WHERE id = $1::uuid
       RETURNING deleted_at`,
      [
        input.documentId,
        input.reason,
        input.memo ?? null,
        input.actor,
        input.noticeRef ?? null,
      ],
    );
    await client.query('COMMIT');
    const chunksCount = await countChunks(input.documentId);
    return {
      documentId: input.documentId,
      deletedAt: updated.rows[0]!.deleted_at,
      reason: input.reason,
      chunksCount,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Clear `deleted_at` only. History fields (reason/memo/by/notice_ref)
 *  are preserved — they become "previous deletion" metadata. */
export async function restoreDocument(input: RestoreInput): Promise<RestoreResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<DocDeletionStateRow>(
      `SELECT id::text AS id, deleted_at, deletion_reason
       FROM documents
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.documentId],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new DocumentNotFoundError(input.documentId);
    }
    const row = existing.rows[0]!;
    if (!row.deleted_at) {
      await client.query('ROLLBACK');
      throw new NotDeletedError(input.documentId);
    }
    await client.query(
      `UPDATE documents SET deleted_at = NULL WHERE id = $1::uuid`,
      [input.documentId],
    );
    await client.query('COMMIT');
    const chunksCount = await countChunks(input.documentId);
    return {
      documentId: input.documentId,
      restoredAt: new Date(),
      previousDeletionReason: (row.deletion_reason as DeletionReason | null) ?? null,
      chunksCount,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Update `last_seen_at` on a (typically soft-deleted) document. Called
 *  by the ingest pipeline when upstream still surfaces the document.
 *  Tolerant of missing rows so the ingest path never fails on this. */
export async function touchLastSeen(documentId: string): Promise<void> {
  await query(
    `UPDATE documents SET last_seen_at = NOW() WHERE id = $1::uuid`,
    [documentId],
  );
}

// ─── Admin read paths (list / single full view) ───

interface AdminDocRow {
  id: string;
  title: string;
  source: string;
  source_id: string;
  deleted_at: Date | null;
  deletion_reason: string | null;
  deletion_memo: string | null;
  deleted_by: string | null;
  deletion_notice_ref: string | null;
  last_seen_at: Date | null;
  external_ids: unknown;
  created_at: Date;
}

export interface AdminDocSummary {
  documentId: string;
  title: string;
  source: string;
  sourceId: string;
  deletedAt: Date | null;
  deletionReason: DeletionReason | null;
  deletionMemo: string | null;
  deletedBy: string | null;
  deletionNoticeRef: string | null;
  lastSeenAt: Date | null;
  externalIds: Record<string, string>;
  createdAt: Date;
}

function rowToAdminSummary(row: AdminDocRow): AdminDocSummary {
  return {
    documentId: row.id,
    title: row.title,
    source: row.source,
    sourceId: row.source_id,
    deletedAt: row.deleted_at,
    deletionReason: (row.deletion_reason as DeletionReason | null) ?? null,
    deletionMemo: row.deletion_memo,
    deletedBy: row.deleted_by,
    deletionNoticeRef: row.deletion_notice_ref,
    lastSeenAt: row.last_seen_at,
    externalIds: (row.external_ids as Record<string, string>) ?? {},
    createdAt: row.created_at,
  };
}

export async function getDocumentForAdmin(documentId: string): Promise<AdminDocSummary | null> {
  const r = await query<AdminDocRow>(
    `SELECT id::text AS id, title, source, source_id,
            deleted_at, deletion_reason, deletion_memo, deleted_by,
            deletion_notice_ref, last_seen_at, external_ids, created_at
     FROM documents WHERE id = $1::uuid`,
    [documentId],
  );
  return r.rows[0] ? rowToAdminSummary(r.rows[0]) : null;
}

export interface ListDeletedParams {
  since?: Date;
  until?: Date;
  reason?: DeletionReason;
  limit?: number;
  offset?: number;
}

export interface ListDeletedResult {
  items: AdminDocSummary[];
  total: number;
  nextOffset: number | null;
}

export async function listDeletedDocuments(params: ListDeletedParams): Promise<ListDeletedResult> {
  const limit = Math.min(params.limit ?? 50, 500);
  const offset = params.offset ?? 0;

  const conditions: string[] = ['deleted_at IS NOT NULL'];
  const args: unknown[] = [];
  if (params.since) { args.push(params.since); conditions.push(`deleted_at >= $${args.length}`); }
  if (params.until) { args.push(params.until); conditions.push(`deleted_at <= $${args.length}`); }
  if (params.reason) { args.push(params.reason); conditions.push(`deletion_reason = $${args.length}`); }
  const where = conditions.join(' AND ');

  const totalRow = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM documents WHERE ${where}`,
    args,
  );
  const total = parseInt(totalRow.rows[0]?.cnt ?? '0', 10);

  args.push(limit);
  const limitIdx = args.length;
  args.push(offset);
  const offsetIdx = args.length;
  const listRows = await query<AdminDocRow>(
    `SELECT id::text AS id, title, source, source_id,
            deleted_at, deletion_reason, deletion_memo, deleted_by,
            deletion_notice_ref, last_seen_at, external_ids, created_at
     FROM documents
     WHERE ${where}
     ORDER BY deleted_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    args,
  );

  const items = listRows.rows.map(rowToAdminSummary);
  const nextOffset = offset + items.length < total ? offset + items.length : null;
  return { items, total, nextOffset };
}
