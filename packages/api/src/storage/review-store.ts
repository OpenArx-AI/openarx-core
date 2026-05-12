/**
 * ReviewStore — CRUD for document_reviews (contracts/content_review.md).
 *
 * Covers Phase 1 scope (openarx-contracts-4pd):
 *   - createInitial: insert version=1 row at publish-time sync-gate
 *   - trigger: idempotent trigger (auto_on_publish returns existing,
 *     manual bumps version)
 *   - getLatest / getByVersion / getAllVersions: read
 *   - patchTier: flip 'basic' → 'full' with idempotency-key dedupe
 *
 * Aspect 2-4 update paths are NOT in this module yet — they will be added
 * alongside their corresponding pipeline step implementations in Phase 2+.
 */

import type { PoolClient } from 'pg';
import { pool, query } from '../db/pool.js';

export type ReviewStatus = 'pending' | 'running' | 'complete' | 'failed';
export type SpamVerdict = 'pass' | 'borderline' | 'reject';
export type TriggeredBy = 'auto_on_publish' | 'manual';
export type ReportTier = 'basic' | 'full';
export type PublicVisibility = 'hidden' | 'verdict_only' | 'detailed';

export interface SpamReason {
  code: string;
  detail?: string;
}

export interface DocumentReview {
  id: string;
  documentId: string;
  version: number;
  triggeredBy: TriggeredBy;
  triggeredAt: Date;
  completedAt: Date | null;
  status: ReviewStatus;
  spamVerdict: SpamVerdict | null;
  spamReasons: SpamReason[] | null;
  qualityScore: number | null;
  qualitySuggestions: unknown[] | null;
  noveltyScore: number | null;
  groundingScore: number | null;
  similarDocuments: unknown[] | null;
  reportSummary: unknown | null;
  llmCosts: number;
  reportTier: ReportTier;
  publicVisibility: PublicVisibility;
}

export interface CreateInitialReviewInput {
  documentId: string;
  triggeredBy: TriggeredBy;
  spamVerdict: SpamVerdict;
  spamReasons: SpamReason[];
  llmCost: number;
  reportTier?: ReportTier;
  /** Phase 1 reviews with aspect 1 only are complete immediately on insert.
   *  Phase 2+ will set status='running' and advance to 'complete' after
   *  aspects 2-3 finish. */
  status?: ReviewStatus;
}

interface ReviewRow {
  id: string;
  document_id: string;
  version: number;
  triggered_by: string;
  triggered_at: Date;
  completed_at: Date | null;
  status: string;
  spam_verdict: string | null;
  spam_reasons: unknown;
  quality_score: string | null;
  quality_suggestions: unknown;
  novelty_score: string | null;
  grounding_score: string | null;
  similar_documents: unknown;
  report_summary: unknown;
  llm_costs: string;
  report_tier: string;
  public_visibility: string;
}

function rowToReview(row: ReviewRow): DocumentReview {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    triggeredBy: row.triggered_by as TriggeredBy,
    triggeredAt: row.triggered_at,
    completedAt: row.completed_at,
    status: row.status as ReviewStatus,
    spamVerdict: (row.spam_verdict as SpamVerdict | null) ?? null,
    spamReasons: row.spam_reasons as SpamReason[] | null,
    qualityScore: row.quality_score !== null ? parseFloat(row.quality_score) : null,
    qualitySuggestions: row.quality_suggestions as unknown[] | null,
    noveltyScore: row.novelty_score !== null ? parseFloat(row.novelty_score) : null,
    groundingScore: row.grounding_score !== null ? parseFloat(row.grounding_score) : null,
    similarDocuments: row.similar_documents as unknown[] | null,
    reportSummary: row.report_summary,
    llmCosts: parseFloat(row.llm_costs),
    reportTier: row.report_tier as ReportTier,
    publicVisibility: row.public_visibility as PublicVisibility,
  };
}

/** Insert the initial review row for a newly published document.
 *  Intended for the synchronous post-aspect-1 flow inside
 *  /api/internal/ingest-document. */
export async function createInitialReview(
  input: CreateInitialReviewInput,
): Promise<DocumentReview> {
  const completedAt = input.status === 'complete' ? new Date() : null;
  const r = await query<ReviewRow>(
    `INSERT INTO document_reviews
       (document_id, version, triggered_by, status, spam_verdict, spam_reasons,
        llm_costs, report_tier, completed_at)
     VALUES ($1::uuid, 1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING *`,
    [
      input.documentId,
      input.triggeredBy,
      input.status ?? 'complete',
      input.spamVerdict,
      JSON.stringify(input.spamReasons),
      input.llmCost.toFixed(4),
      input.reportTier ?? 'full',
      completedAt,
    ],
  );
  return rowToReview(r.rows[0]!);
}

/** Trigger a review explicitly. Idempotent on auto_on_publish (returns
 *  the existing latest row). On manual trigger, bumps version by one
 *  with status='pending' and fresh timestamps. */
export async function triggerReview(
  documentId: string,
  triggeredBy: TriggeredBy,
): Promise<{ review: DocumentReview; wasCreated: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const latest = await client.query<ReviewRow>(
      `SELECT * FROM document_reviews
       WHERE document_id = $1::uuid
       ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [documentId],
    );

    if (triggeredBy === 'auto_on_publish' && latest.rows.length > 0) {
      // Existing row — no-op (aspect 1 already ran during original publish).
      await client.query('COMMIT');
      return { review: rowToReview(latest.rows[0]!), wasCreated: false };
    }

    const nextVersion = (latest.rows[0]?.version ?? 0) + 1;
    const inserted = await client.query<ReviewRow>(
      `INSERT INTO document_reviews
         (document_id, version, triggered_by, status)
       VALUES ($1::uuid, $2, $3, 'pending')
       RETURNING *`,
      [documentId, nextVersion, triggeredBy],
    );
    await client.query('COMMIT');
    return { review: rowToReview(inserted.rows[0]!), wasCreated: true };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
}

/** Return the latest review version for a document, or null. */
export async function getLatestReview(documentId: string): Promise<DocumentReview | null> {
  const r = await query<ReviewRow>(
    `SELECT * FROM document_reviews
     WHERE document_id = $1::uuid
     ORDER BY version DESC LIMIT 1`,
    [documentId],
  );
  return r.rows.length > 0 ? rowToReview(r.rows[0]!) : null;
}

/** Return a specific version. */
export async function getReviewByVersion(
  documentId: string,
  version: number,
): Promise<DocumentReview | null> {
  const r = await query<ReviewRow>(
    `SELECT * FROM document_reviews
     WHERE document_id = $1::uuid AND version = $2`,
    [documentId, version],
  );
  return r.rows.length > 0 ? rowToReview(r.rows[0]!) : null;
}

/** Return all versions ASC. Used for retention audit + admin views. */
export async function getAllReviewVersions(documentId: string): Promise<DocumentReview[]> {
  const r = await query<ReviewRow>(
    `SELECT * FROM document_reviews
     WHERE document_id = $1::uuid
     ORDER BY version ASC`,
    [documentId],
  );
  return r.rows.map(rowToReview);
}

/** Advance the latest review row for a document to status='running' at
 *  the start of Aspect 3 worker execution. No-op if the row is already
 *  in 'running' or 'complete' — safe to call from retry paths. */
export async function markReviewRunning(documentId: string): Promise<void> {
  await query(
    `UPDATE document_reviews
     SET status = 'running'
     WHERE id = (
       SELECT id FROM document_reviews
       WHERE document_id = $1::uuid
       ORDER BY version DESC LIMIT 1
     )
     AND status = 'pending'`,
    [documentId],
  );
}

/** Mark the latest review row 'failed' when the underlying ingest pipeline
 *  fails before reaching the review_novelty step. Without this, Portal
 *  polling sees status='pending' indefinitely (worker never runs because
 *  the doc never reaches that DAG node).
 *
 *  Only acts if the row is currently 'pending' or 'running' — never
 *  downgrades a 'complete' or 'failed' row. No-op for arxiv docs that
 *  have no review row attached. */
export async function markReviewFailed(documentId: string, reason?: string): Promise<void> {
  await query(
    `UPDATE document_reviews
     SET status = 'failed',
         completed_at = COALESCE(completed_at, now()),
         spam_reasons = CASE
           WHEN $2::text IS NOT NULL THEN
             COALESCE(spam_reasons, '[]'::jsonb)
             || jsonb_build_array(jsonb_build_object('code', 'PIPELINE_FAILED', 'detail', $2::text))
           ELSE spam_reasons
         END
     WHERE id = (
       SELECT id FROM document_reviews
       WHERE document_id = $1::uuid
       ORDER BY version DESC LIMIT 1
     )
     AND status IN ('pending', 'running')`,
    [documentId, reason ?? null],
  );
}

/** Write Aspect 3 (Novelty + Grounding) outputs onto the latest review
 *  row and mark it complete. Called at the end of the novelty worker.
 *  Fields may be NULL on non-blocking failure — callers that couldn't
 *  compute valid aspect 3 should still transition status to 'complete'
 *  with NULLs to unblock polling (per contract §3). */
export async function updateAspect3Fields(
  documentId: string,
  input: {
    noveltyScore: number | null;
    groundingScore: number | null;
    similarDocuments: unknown[] | null;
  },
): Promise<void> {
  await query(
    `UPDATE document_reviews
     SET novelty_score = $2,
         grounding_score = $3,
         similar_documents = $4::jsonb,
         status = 'complete',
         completed_at = COALESCE(completed_at, now())
     WHERE id = (
       SELECT id FROM document_reviews
       WHERE document_id = $1::uuid
       ORDER BY version DESC LIMIT 1
     )`,
    [
      documentId,
      input.noveltyScore !== null ? input.noveltyScore.toFixed(4) : null,
      input.groundingScore !== null ? input.groundingScore.toFixed(4) : null,
      input.similarDocuments ? JSON.stringify(input.similarDocuments) : null,
    ],
  );
}

export interface PatchTierResult {
  previousTier: ReportTier;
  currentTier: ReportTier;
  idempotencyReplay: boolean;
  review: DocumentReview;
}

/** Change the report_tier for a document's latest review.
 *  Idempotency is enforced by the caller via a key passed to this
 *  function — this function only performs the UPDATE; the caller
 *  records/replays via Redis. Returns idempotencyReplay=false always
 *  from this method (caller layers replay semantics above it). */
export async function patchLatestReviewTier(
  documentId: string,
  newTier: ReportTier,
): Promise<PatchTierResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const latest = await client.query<ReviewRow>(
      `SELECT * FROM document_reviews
       WHERE document_id = $1::uuid
       ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [documentId],
    );
    if (latest.rows.length === 0) {
      await safeRollback(client);
      throw new Error(`no review for document ${documentId}`);
    }
    const previous = rowToReview(latest.rows[0]!);
    if (previous.reportTier === newTier) {
      await client.query('COMMIT');
      return {
        previousTier: previous.reportTier,
        currentTier: previous.reportTier,
        idempotencyReplay: false,
        review: previous,
      };
    }
    const updated = await client.query<ReviewRow>(
      `UPDATE document_reviews SET report_tier = $1
       WHERE id = $2::uuid
       RETURNING *`,
      [newTier, previous.id],
    );
    await client.query('COMMIT');
    return {
      previousTier: previous.reportTier,
      currentTier: newTier,
      idempotencyReplay: false,
      review: rowToReview(updated.rows[0]!),
    };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}
