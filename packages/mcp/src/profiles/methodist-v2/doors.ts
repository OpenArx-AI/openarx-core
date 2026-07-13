// ── methodist-v2 door surface (F2.3) ─────────────────────────────────────────
//
// The eight §3 doors as MCP tools. Six are methodology PROCEDURES driven by the
// interpreter (diagnose/checkpoint/course/consult/get_current_dose/report_need);
// two are direct non-model channels (escalate/get_my_development). The mentee
// credential is the AUTH-token owner (boundary-1, server-bound) — never a free param.
//
// NOT wired into the live researcher/v1/pub/layer2 profiles here: the role-gate +
// mount ride with gateway-v4 (F2.7) in Phase 3. This registration is mount-ready.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runEndpoint } from '@openarx/methodist';
import { getDossier, appendRunJournal, recordMethodistIdempotency } from '@openarx/api';
import { canonicalBytes } from '@openarx/types';

/** SHA-256 hex over a string (the §4.3 JCS canonical bytes of a hand-in). */
function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
import type { AppContext } from '../../context.js';
import { credentialFromToken } from '../../portal-auth.js';
import { jsonResult } from '../shared/helpers.js';
import { buildDoorEngine } from './engine.js';

function errJson(data: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: true };
}

/** Credential = the token owner as a stable COMPOSITE of (userId, tokenId) — server-bound
 *  (boundary-1), never a free-typed param. Delegates to credentialFromToken (the SINGLE
 *  mint used here AND by the tool-log keying in index.ts — see 2f / §12.2). */
function credentialOf(extra: unknown): string {
  const token = (extra as Record<string, unknown> | undefined)?._portalToken as { userId?: string; tokenId?: string } | undefined;
  return credentialFromToken(token);
}

export function registerMethodistDoors(server: McpServer, _ctx: AppContext): void {
  const engine = buildDoorEngine();

  // ── methodist — the SINGLE model door (§3.1) ─────────────────────────────────
  // route-intent (pre-model) dispatches by intent: no active run → diagnose; an
  // explicit publish signal in payload → checkpoint; otherwise → ask (the merged
  // course/consult). The 4 former model doors (diagnose/checkpoint/course/consult)
  // are removed — no aliases. The mentee credential is server-bound; the mode fields
  // live in `payload`, which the routed sub-procedure reads.
  server.tool(
    'methodist',
    'The single methodist model door — routed by intent. No active run → diagnose (a research INTENT → the cycle + entry point + the first dose). An explicit publish signal in the payload → checkpoint (hand in a stage: GO publishes the quality-stamped claim + issues the next dose; RETURN gives corrections with WHY — you do not decide publication, the verdict does). Otherwise → ask (mid-stage direction or a stateless clarifying question — a hint/beacon/patch, never the solution; boundary 1). Directs, never does the work.',
    {
      run_id: z.string().optional().describe('The active run (omit to start a new run — routes to diagnose)'),
      payload: z
        .record(z.unknown())
        .describe(
          'Mode fields the routed sub-procedure reads: diagnose → {intent, focus?, parent_run_id?}; checkpoint → {submission{records[],track_note?}, submission_hash, stage, claimed_usage?}; ask → {question, focus?}',
        ),
    },
    async ({ run_id, payload }, extra) => {
      try {
        const payloadObj = (payload ?? {}) as Record<string, unknown>;
        // openarx-abvc (A): SERVER-derive the idempotency key over the FULL hand-in (§4.3 JCS
        // over records + track_note + claimed_usage) — NOT the client-opaque submission_hash.
        // Consequences: a correction to ANY of these (e.g. fixing a tool-usage claim that lives
        // in track_note) changes the key → the model re-judges; only a byte-identical re-submit
        // stays idempotent (§2g intact). Also closes an anti-gaming surface — the mentee no
        // longer controls its own idempotency key. Server-set here so BOTH the check-idempotency
        // gate (inside runEndpoint) and the post-outcome record below use the same server value.
        const sub = payloadObj.submission as { records?: unknown; track_note?: unknown } | undefined;
        if (sub && typeof sub === 'object') {
          payloadObj.submission_hash = sha256Hex(
            canonicalBytes({ records: sub.records ?? null, track_note: sub.track_note ?? null, claimed_usage: payloadObj.claimed_usage ?? null }),
          );
        }
        const r = await runEndpoint(engine, 'methodist', {
          agent_id: credentialOf(extra),
          run_id: run_id ?? null,
          payload: payloadObj,
        });
        // 2g / bass: record the outcome keyed by (run_id, stage, submission_hash) — GO's ref
        // AND a RETURN's reasons/corrections — so an identical re-submit at the same stage
        // short-circuits at the check-idempotency gate BEFORE call-model (no re-run → no
        // "roll the submission until a random GO"). first-writer-wins (ON CONFLICT DO NOTHING),
        // so an idempotent replay never re-writes. DIFFERENT work (new hash) keys elsewhere →
        // the model still judges it (the refinement cycle stays alive). Hash is now server-derived (A).
        const submissionHash = payloadObj.submission_hash;
        const stage = payloadObj.stage;
        if (run_id && typeof submissionHash === 'string' && stage != null) {
          const key = `${run_id}:${stage}:${submissionHash}`;
          const committed = (r.slots?.committed ?? {}) as { bundle_id?: string };
          const resp = (r.response ?? {}) as Record<string, unknown>;
          if (r.outcome === 'GO' && typeof committed.bundle_id === 'string') {
            await recordMethodistIdempotency(key, { verdict: 'GO', ref: committed.bundle_id });
          } else if (r.outcome === 'RETURN') {
            await recordMethodistIdempotency(key, { verdict: 'RETURN', reasons: resp.reasons ?? null, corrections: resp.corrections ?? null });
          }
        }
        // openarx-abvc (C): transparent idempotent replay. A byte-identical hand-in (same
        // server-derived hash) short-circuits at check-idempotency and REPLAYS the cached
        // verdict — it is NOT re-evaluated. Surface that plainly (`replayed`) so a cached
        // RETURN's stale corrections are never mistaken for a fresh audit; the mentee knows to
        // CHANGE the submission (not just re-send) to trigger a re-judge. With (A) a genuine
        // correction already changes the hash → fresh judge; this only tags true replays.
        if (r.outcome === 'idempotent') {
          return jsonResult({
            outcome: r.outcome,
            ...r.response,
            replayed: true,
            note: 'Idempotent replay: this exact hand-in (records + track_note + claimed_usage) was already judged — the cached verdict is returned, NOT a fresh evaluation. Change the submission to trigger a re-judge.',
          });
        }
        // closeout write-path (A) — openarx-ls78 / contracts ruling 0010: on GO, surface the
        // id_map ({local_ref → canonical claim id}) that resolve-local-ids computed, so the mentee
        // (the AUTHOR of these science records) gets back the ids of its just-persisted claims and
        // can reference them (source_claim_id/target_claim_id) in a LATER closeout-checkpoint's
        // relation records — the single methodist door is the ONLY graph-publish path (v4/§12.3;
        // standalone submit_* tools removed by 1woy). This is what enables cross-stage relations →
        // edges. RETURN persists no claims → no id_map. Process ids (run_id) are NOT in the id_map
        // (it holds claim/relation content-ids only).
        const idMap =
          r.outcome === 'GO'
            ? (r.slots?.resolved as { id_map?: Record<string, string> } | undefined)?.id_map
            : undefined;
        // methodist write-path observability (Vlad): confirm the id_map the mentee needs for
        // cross-stage relations is actually populated on GO (empty id_map = the mentee submitted
        // claims WITHOUT local_ids _:cN → no ids returned → can't build cross-stage relations).
        if (r.outcome === 'GO' || r.outcome === 'RETURN') {
          const submittedRecords = Array.isArray((payloadObj.submission as { records?: unknown })?.records)
            ? ((payloadObj.submission as { records: unknown[] }).records).length
            : 0;
          console.error(
            JSON.stringify({
              at: 'checkpoint.response',
              outcome: r.outcome,
              submitted_records: submittedRecords,
              id_map_keys: idMap ? Object.keys(idMap).length : 0,
            }),
          );
        }
        return jsonResult({
          outcome: r.outcome,
          ...r.response,
          ...(idMap && Object.keys(idMap).length > 0 ? { id_map: idMap } : {}),
        });
      } catch (e) {
        return errJson({ error: 'methodist_failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // ── get_current_dose (deterministic) ─────────────────────────────────────────
  server.tool(
    'methodist_get_current_dose',
    "Return the run's current dose, stage and status (where am I). Deterministic — no model call.",
    { run_id: z.string().min(1) },
    async ({ run_id }) => {
      try {
        const r = await runEndpoint(engine, 'get_current_dose', { run_id });
        return jsonResult({ outcome: r.outcome, ...r.response });
      } catch (e) {
        return errJson({ error: 'get_current_dose_failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // ── report_need (deterministic) ──────────────────────────────────────────────
  server.tool(
    'methodist_report_need',
    'Report a blocking need (e.g. missing access/resource); pauses the run and records the need.',
    { run_id: z.string().min(1), need: z.string().min(1) },
    async ({ run_id, need }) => {
      try {
        const r = await runEndpoint(engine, 'report_need', { run_id, need });
        return jsonResult({ outcome: r.outcome, ...r.response });
      } catch (e) {
        return errJson({ error: 'report_need_failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // ── escalate (non-model channel) ─────────────────────────────────────────────
  server.tool(
    'methodist_escalate',
    "Escalate above the methodist (PM/human). The mentee has a standing right to escalate over the methodist's head (inv-5). Returns a ticket; the resolution arrives via the next checkpoint or get_my_development.",
    {
      run_id: z.string().optional(),
      class: z.string().optional().describe('Escalation class (open set): dispute | unfair-return | tier | other'),
      detail: z.string().optional(),
    },
    async ({ run_id, class: klass, detail }, extra) => {
      try {
        const ticket = `esc:${randomUUID()}`;
        if (run_id) {
          await appendRunJournal({
            run_id,
            event: 'escalate',
            payload: { credential: credentialOf(extra), class: klass ?? 'other', detail: detail?.slice(0, 500) ?? null, ticket },
          });
        }
        return jsonResult({ ticket, status: 'received', class: klass ?? 'other' });
      } catch (e) {
        return errJson({ error: 'escalate_failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // ── get_my_development (non-model channel — the mentee's own competence view) ─
  server.tool(
    'methodist_get_my_development',
    'The mentee\'s own development view: autonomy by context, passed units, tier, and pending corrections (the flat competence map the methodist keeps).',
    {},
    async (_args, extra) => {
      try {
        const d = await getDossier(credentialOf(extra));
        if (!d) return jsonResult({ present: false, autonomy_by_context: {}, passed_units: [], tier_by_context: {}, corrections: [] });
        return jsonResult({
          present: true,
          autonomy_by_context: d.autonomy_by_context,
          passed_units: d.passed_units,
          tier_by_context: d.tier_by_context,
          corrections: d.corrections,
        });
      } catch (e) {
        return errJson({ error: 'get_my_development_failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
  );
}
