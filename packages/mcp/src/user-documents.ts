/**
 * GET /api/internal/user-documents — paginated list of a user's documents for
 * the Portal backend (openarx-contracts-amc7, document_publication_pipeline.md
 * §15.2). X-Internal-Secret authed (applied by the internal router).
 *
 * Keyset pagination over (updated_at DESC, id DESC); cursor is an opaque
 * base64url of `${updated_at_iso}|${id}`. `since` filters by updated_at so
 * Portal can pull only changed docs. Status / tier / spam_verdict / review_status
 * are Core's internal vocabulary — Portal translates per §15.4.
 */
import type { Request, Response } from 'express';
import type { AppContext } from './context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface DocumentSummary {
  core_document_id: string;
  oarx_id: string | null;
  title: string;
  authors: unknown;
  format: string | null;
  status: string;
  tier: string | null;
  created_at: string;
  updated_at: string;
  license: string | null;
  spam_verdict: 'pass' | 'review' | 'rejected' | null;
  review_status: 'complete' | 'pending' | 'failed' | null;
}

/** Core spam_verdict (pass/borderline/reject) → contract enum (§15.2). */
export function mapSpamVerdict(v: string | null | undefined): DocumentSummary['spam_verdict'] {
  switch (v) {
    case 'pass': return 'pass';
    case 'borderline': return 'review';
    case 'reject': return 'rejected';
    default: return null;
  }
}

/** Core review status (pending/running/complete/failed) → contract enum. */
export function mapReviewStatus(s: string | null | undefined): DocumentSummary['review_status'] {
  switch (s) {
    case 'complete': return 'complete';
    case 'failed': return 'failed';
    case 'pending':
    case 'running': return 'pending'; // running collapses to "in progress"
    default: return null;
  }
}

export function encodeCursor(updatedAt: Date | string, id: string): string {
  const iso = updatedAt instanceof Date ? updatedAt.toISOString() : new Date(updatedAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf-8').toString('base64url');
}

/** Decode an opaque cursor; returns null for any malformed input (treated as
 *  "start from the beginning" rather than erroring). */
export function decodeCursor(s: string): { updatedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf-8');
    const i = decoded.lastIndexOf('|');
    if (i < 0) return null;
    const updatedAt = decoded.slice(0, i);
    const id = decoded.slice(i + 1);
    if (!UUID_RE.test(id) || Number.isNaN(new Date(updatedAt).getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

interface DocRow {
  id: string;
  oarx_id: string | null;
  title: string;
  authors: unknown;
  source_format: string | null;
  status: string;
  indexing_tier: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  license: string | null;
  spam_verdict: string | null;
  review_status: string | null;
}

function toSummary(r: DocRow): DocumentSummary {
  const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  return {
    core_document_id: r.id,
    oarx_id: r.oarx_id ?? null,
    title: r.title,
    authors: r.authors ?? [],
    format: r.source_format ?? null,
    status: r.status,
    tier: r.indexing_tier ?? null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    license: r.license ?? null,
    spam_verdict: mapSpamVerdict(r.spam_verdict),
    review_status: mapReviewStatus(r.review_status),
  };
}

export async function handleUserDocuments(req: Request, res: Response, ctx: AppContext): Promise<void> {
  const userId = req.query.user_id;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    res.status(400).json({ error: 'user_required', message: 'user_id (UUID) query param is required' });
    return;
  }

  let limit = DEFAULT_LIMIT;
  if (typeof req.query.limit === 'string') {
    const n = parseInt(req.query.limit, 10);
    if (Number.isFinite(n)) limit = Math.min(MAX_LIMIT, Math.max(1, n));
  }

  let since: string | null = null;
  if (typeof req.query.since === 'string') {
    const d = new Date(req.query.since);
    if (!Number.isNaN(d.getTime())) since = d.toISOString();
  }

  const cursor = typeof req.query.cursor === 'string' ? decodeCursor(req.query.cursor) : null;

  const params: unknown[] = [userId];
  const where: string[] = ['d.publisher_user_id = $1::uuid', 'd.deleted_at IS NULL'];
  if (since) {
    params.push(since);
    where.push(`d.updated_at >= $${params.length}::timestamptz`);
  }
  if (cursor) {
    params.push(cursor.updatedAt);
    const ai = params.length;
    params.push(cursor.id);
    const bi = params.length;
    where.push(`(d.updated_at, d.id) < ($${ai}::timestamptz, $${bi}::uuid)`);
  }
  params.push(limit + 1);
  const limitIdx = params.length;

  let rows: DocRow[];
  try {
    const result = await ctx.pool.query<DocRow>(
      `SELECT d.id::text AS id, d.oarx_id, d.title, d.authors, d.source_format,
              d.status, d.indexing_tier, d.created_at, d.updated_at, d.license,
              r.spam_verdict, r.review_status
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT spam_verdict, status AS review_status
             FROM document_reviews
            WHERE document_id = d.id
            ORDER BY version DESC LIMIT 1
         ) r ON true
        WHERE ${where.join(' AND ')}
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT $${limitIdx}`,
      params,
    );
    rows = result.rows;
  } catch (err) {
    console.error('[user-documents] DB error:', err instanceof Error ? err.message : err);
    res.status(503).json({ error: 'user_documents_unavailable', message: 'document store unavailable' });
    return;
  }

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const lastReturned = rows[limit - 1];
    rows = rows.slice(0, limit);
    nextCursor = encodeCursor(lastReturned.updated_at, lastReturned.id);
  }

  res.status(200).json({ docs: rows.map(toSummary), next_cursor: nextCursor });
}
