// ── Methodist channel — dossier store + deterministic mechanics (§13) ─────────
//
// Methodist-internal operational state (migration 044). This module holds the
// DETERMINISTIC mechanics of the protocol invariants (§13.3) — no LLM carrier:
//   - inv.1 mechanical stop-rule: a checkpoint for stage N+1 needs a recorded
//     GO(N) — hasGo() is the gate.
//   - inv.2 idempotency: a resubmitted hand-in (same handinHash) replays the
//     stored response — findByHandinHash() + the unique index.
//   - inv.6/7 dossier transparency: the dossier is readable in full and every
//     checkpoint records what changed.
// The Gemini 3 Pro carrier (dose/diagnosis CONTENT) is layered ON TOP of these
// mechanics and does not change this module.

import { createHash } from 'node:crypto';
import { canonicalBytes } from '@openarx/types';
import { query } from '../db/pool.js';

export interface MethodistDossier {
  credential_id: string;
  autonomy: string;
  cycles_passed: string[];
  patches: unknown[];
  track_record: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CheckpointRecord {
  id: string;
  credential_id: string;
  stage: string;
  handin_hash: string;
  response: Record<string, unknown>;
  go: boolean;
  created_at: string;
}

export interface EscalationRecord {
  ticket: string;
  credential_id: string;
  review_run_id: string | null;
  issue: string;
  class: string;
  status: string;
  resolution: Record<string, unknown> | null;
  created_at: string;
}

/** Deterministic hand-in hash for idempotency (inv.2) — RFC 8785 canonical bytes + SHA-256. */
export function handinHash(input: {
  credential_id: string;
  stage: string | number;
  track_note: string;
  artifacts: unknown;
}): string {
  const canonical = canonicalBytes({
    credential_id: input.credential_id,
    stage: String(input.stage),
    track_note: input.track_note,
    artifacts: input.artifacts ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Fetch a dossier, creating an empty A0 one on first contact. */
export async function getOrCreateDossier(credentialId: string): Promise<MethodistDossier> {
  await query(
    `INSERT INTO methodist_dossier (credential_id) VALUES ($1) ON CONFLICT (credential_id) DO NOTHING`,
    [credentialId],
  );
  const r = await query<MethodistDossier>(
    `SELECT credential_id, autonomy, cycles_passed, patches, track_record,
            created_at::text, updated_at::text
       FROM methodist_dossier WHERE credential_id = $1`,
    [credentialId],
  );
  return r.rows[0]!;
}

/** inv.1 stop-rule: has a GO been recorded for this exact stage? */
export async function hasGo(credentialId: string, stage: string): Promise<boolean> {
  const r = await query<{ one: number }>(
    `SELECT 1 AS one FROM methodist_checkpoints WHERE credential_id = $1 AND stage = $2 AND go = true LIMIT 1`,
    [credentialId, stage],
  );
  return r.rows.length > 0;
}

/** inv.2 idempotency: the stored response for a previously-seen hand-in, if any. */
export async function findByHandinHash(handin: string): Promise<CheckpointRecord | null> {
  const r = await query<CheckpointRecord>(
    `SELECT id::text, credential_id, stage, handin_hash, response, go, created_at::text
       FROM methodist_checkpoints WHERE handin_hash = $1`,
    [handin],
  );
  return r.rows[0] ?? null;
}

/**
 * Record a checkpoint hand-in + its response. Idempotent on handin_hash: a
 * concurrent/repeat insert returns the ALREADY-stored row (created=false) so the
 * caller replays the same response.
 */
export async function recordCheckpoint(rec: {
  credentialId: string;
  stage: string;
  handinHash: string;
  response: Record<string, unknown>;
  go: boolean;
}): Promise<{ created: boolean; record: CheckpointRecord }> {
  const ins = await query<{ id: string }>(
    `INSERT INTO methodist_checkpoints (credential_id, stage, handin_hash, response, go)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (handin_hash) DO NOTHING
     RETURNING id`,
    [rec.credentialId, rec.stage, rec.handinHash, JSON.stringify(rec.response), rec.go],
  );
  const stored = (await findByHandinHash(rec.handinHash))!;
  return { created: ins.rows.length > 0, record: stored };
}

/** inv.5 escalation: create a ticket. Deterministic id (crypto), status open. */
export async function createEscalation(rec: {
  credentialId: string;
  reviewRunId: string | null;
  issue: string;
  klass: string;
}): Promise<EscalationRecord> {
  const ticket = `esc_${createHash('sha256')
    .update(`${rec.credentialId}|${rec.reviewRunId ?? ''}|${rec.issue}|${rec.klass}`)
    .digest('hex')
    .slice(0, 20)}`;
  await query(
    `INSERT INTO methodist_escalations (ticket, credential_id, review_run_id, issue, class)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ticket) DO NOTHING`,
    [ticket, rec.credentialId, rec.reviewRunId, rec.issue, rec.klass],
  );
  const r = await query<EscalationRecord>(
    `SELECT ticket, credential_id, review_run_id, issue, class, status, resolution, created_at::text
       FROM methodist_escalations WHERE ticket = $1`,
    [ticket],
  );
  return r.rows[0]!;
}

/** Open/resolved escalations for a mentee (surfaced via get_my_development + next checkpoint). */
export async function getEscalations(credentialId: string): Promise<EscalationRecord[]> {
  const r = await query<EscalationRecord>(
    `SELECT ticket, credential_id, review_run_id, issue, class, status, resolution, created_at::text
       FROM methodist_escalations WHERE credential_id = $1 ORDER BY created_at DESC`,
    [credentialId],
  );
  return r.rows;
}

// ── Activity placement (PM ruling §13.3): process → internal journal; outcomes → public ──

/**
 * inv.4 — record a PROCESS exchange in the INTERNAL methodist journal (NOT the
 * public Layer 2 graph). Preserves the anti-gaming audit without leaking the
 * correction-density signal the dossier keeps private. Carries the A3 fields.
 */
export async function recordJournalExchange(rec: {
  credentialId: string;
  tool: string;
  genre: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO methodist_journal (credential_id, tool, applied_instrument, genre, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [rec.credentialId, rec.tool, rec.tool, rec.genre, JSON.stringify(rec.detail)],
  );
}

// recordOutcomeActivity + OutcomeClass REMOVED with the PG-graph teardown (openarx-1woy):
// they wrote a public activity into the dropped PG layer2_activities table and had no live
// caller. The wave-v2 methodist path publishes outcomes as scientific records via the
// checkpoint door (methodist-v2), not through this legacy PG writer.
