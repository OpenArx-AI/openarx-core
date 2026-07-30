// ── methodist door-engine runtime store (wave-v2, migration 047) ─────────────
//
// PG-backed stores the door interpreter binds beyond Neo4j/dossier:
//   • run-scoped journal — append-journal events + the live tool-log crosscheck
//     reconciles claimed_usage against (§8 inv-4 anti-gaming).
//   • idempotency index — check-idempotency (submission_hash → prior ref).

import { query } from '../db/pool.js';
import { neoGet } from '../db/neo4j.js';

export interface RunJournalEntry {
  id: string;
  run_id: string;
  tool: string | null;
  event: string | null;
  payload: unknown;
}

/** append-journal → a door exchange event ({run_id, event, payload}). */
export async function appendRunJournal(entry: {
  run_id: string;
  tool?: string | null;
  event?: string | null;
  payload?: unknown;
}): Promise<{ id: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO methodist_run_journal (run_id, tool, event, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text AS id`,
    [entry.run_id, entry.tool ?? null, entry.event ?? null, entry.payload == null ? null : JSON.stringify(entry.payload)],
  );
  return { id: r.rows[0]!.id };
}

/** All journal rows for a run (crosscheck filters tool-log entries in-memory). */
export async function listRunJournal(runId: string): Promise<RunJournalEntry[]> {
  const r = await query<RunJournalEntry>(
    `SELECT id::text AS id, run_id, tool, event, payload
       FROM methodist_run_journal WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  );
  return r.rows;
}

/**
 * Record a LIVE tool call for a run (the crosscheck tool-log). Written by MCP
 * call-interception so claimed_usage is reconciled against what actually ran —
 * NOT a seeded stand-in. Best-effort: journal failure must never break the call.
 */
export async function logRunToolCall(runId: string, tool: string): Promise<void> {
  await query(`INSERT INTO methodist_run_journal (run_id, tool) VALUES ($1, $2)`, [runId, tool]);
}

/**
 * Record a LIVE tool call by an authenticated credential (migration 048). The gateway
 * MCP call-interception writes here for every researcher tool call — the real anti-gaming
 * tool-log (§8 inv-4). Best-effort: a journal failure must never break the tool call.
 *
 * §8-inv4 run_id-threading (migration 053, contracts EMPTY_LOG KEYING FIX): when the mentee
 * threads a run_id (and the boundary validated ownership) the row is ALSO run-anchored — the
 * crosscheck then reads it by run_id, immune to token-refresh credential divergence (the empty_log
 * root). `runId` omitted/null → credential-only row (the backward-compatible pre-threading path).
 */
export async function logMethodistToolCall(credentialId: string, tool: string, runId?: string | null): Promise<void> {
  await query(`INSERT INTO methodist_tool_log (credential_id, tool, run_id) VALUES ($1, $2, $3)`, [credentialId, tool, runId ?? null]);
}

/**
 * The STABLE run-owner hash (sha256(userId), 'own:'-prefixed) a run node carries — the run-ownership
 * basis for the tool-call boundary (§8-inv4 run_id-threading, contracts EMPTY_LOG KEYING FIX).
 * Returns: the owner_hash string; `null` for a PRE-CHANGE run (created before owner_hash existed →
 * ownership indeterminate → the boundary falls back, never rejects, backward-compat); `undefined`
 * for NO SUCH run (the boundary REJECT-HARDs — invalid/foreign run_id). Throws only on a store fault
 * (the boundary treats a fault as fallback, not a reject, so an infra blip never blocks a call).
 */
export async function getRunOwnerHash(runId: string): Promise<string | null | undefined> {
  const run = (await neoGet('run', 'run_id', runId)) as { owner_hash?: string | null } | undefined;
  if (run === undefined) return undefined;
  return run.owner_hash ?? null;
}

/** Per-call door-model LLM cost ledger row (migration 052, Console 694n). Persists what the
 *  engine model-client already computes for the ROI log so Console can show the cost breakdown +
 *  cache-hit rate (cached_tokens/input_tokens) per day/version. Best-effort — a cost-log failure
 *  must never break the door call. */
export async function recordMethodistLlmCost(row: {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cost: number;
  door?: string | null;
  runId?: string | null;
  credentialId?: string | null;
  methodologyVersion?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO methodist_llm_costs
       (door, model, input_tokens, cached_tokens, output_tokens, cost, run_id, credential_id, methodology_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.door ?? null,
      row.model,
      row.inputTokens,
      row.cachedTokens,
      row.outputTokens,
      row.cost,
      row.runId ?? null,
      row.credentialId ?? null,
      row.methodologyVersion ?? null,
    ],
  );
}

/**
 * The crosscheck view for a run: the tools the run's credential actually called since
 * the run started, shaped as {run_id, tool} entries (what crosscheck-tool-usage expects
 * from the journal). Run→credential from the Neo4j run node; run start = the earliest
 * run-journal event (diagnose). NOTE: attributed by credential+window, so with two
 * concurrent runs by one credential the window overlaps — acceptable for the single-run
 * mentee flow; tighten with an explicit run tag if concurrent runs become common.
 */
export async function listRunToolLog(runId: string): Promise<Array<{ run_id: string; tool: string }>> {
  const run = (await neoGet('run', 'run_id', runId)) as { credential_id?: string } | undefined;
  const credentialId = run?.credential_id ?? null;
  // openarx-abvc (B): window the tool-log to the CURRENT stage — from the last checkpoint_go
  // (the GO that advanced into this stage), NOT the whole run. Whole-run mixes earlier stages'
  // tool calls into the crosscheck → a false `logged_not_claimed` for an honest zero-usage stage
  // (the mentee claims tool-usage for the work submitted NOW). No prior GO (stage 1) → fall back
  // to run start (earliest journal event). Merges the OBS-4 crosscheck-scope defect.
  const startRow = await query<{ started: string | null }>(
    `SELECT COALESCE(
       (SELECT max(created_at) FROM methodist_run_journal WHERE run_id = $1 AND event = 'checkpoint_go'),
       (SELECT min(created_at) FROM methodist_run_journal WHERE run_id = $1)
     )::text AS started`,
    [runId],
  );
  const started = startRow.rows[0]?.started ?? null;
  // §8-inv4 run_id-threading (migration 053, contracts EMPTY_LOG KEYING FIX) — DUAL-KEY read:
  //   PRIMARY  = rows attributed DIRECTLY by run_id (written when the mentee threaded run_id +
  //              the boundary validated ownership) → immune to token-refresh credential divergence.
  //   FALLBACK = un-threaded rows (run_id IS NULL) by credential+window (the pre-threading path;
  //              a token-refresh scatters these across credentials → the crosscheck's note-iii
  //              inconclusive/benign path, NEVER fabrication). Kept so the transition doesn't
  //              orphan un-threaded rows (contracts point 2: dual-key, not a clean cutover).
  // The stage window applies to BOTH branches (an honest zero-usage stage stays clean).
  const r = await query<{ tool: string }>(
    `SELECT tool FROM methodist_tool_log
      WHERE ( run_id = $1 ${started ? 'AND called_at >= $3' : ''} )
         OR ( run_id IS NULL AND credential_id = $2 ${started ? 'AND called_at >= $3' : ''} )
      ORDER BY called_at`,
    started ? [runId, credentialId, started] : [runId, credentialId],
  );
  return r.rows.map((x) => ({ run_id: runId, tool: x.tool }));
}

/** check-idempotency read (2g): `(run_id:stage:submission_hash)` → the stored replayable
 *  outcome ({verdict, ref?, reasons?, corrections?}) or null. A legacy ref-only (GO) row
 *  normalizes to { verdict:'GO', ref }. */
export async function getMethodistIdempotency(key: string): Promise<Record<string, unknown> | null> {
  const r = await query<{ ref: string | null; outcome: Record<string, unknown> | null }>(
    `SELECT ref, outcome FROM methodist_idempotency WHERE key = $1`,
    [key],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.outcome != null) return row.outcome;
  return typeof row.ref === 'string' ? { verdict: 'GO', ref: row.ref } : null;
}

/** Record a hand-in's outcome under its idempotency key (first-writer-wins). 2g: stores the
 *  full replayable outcome (GO ref OR RETURN reasons/corrections); `ref` mirrors outcome.ref
 *  for the GO case (nullable for RETURN). */
export async function recordMethodistIdempotency(key: string, outcome: Record<string, unknown>): Promise<void> {
  const ref = typeof outcome.ref === 'string' ? outcome.ref : null;
  await query(
    `INSERT INTO methodist_idempotency (key, ref, outcome) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO NOTHING`,
    [key, ref, JSON.stringify(outcome)],
  );
}
