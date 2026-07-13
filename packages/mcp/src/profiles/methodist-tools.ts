// ── Methodist MCP channel — 5 tools (mcp_profiles_v3.md §13) ──────────────────
//
// Freeze-critical surface: the 5 tool SIGNATURES + the `methodist` scope + the
// DETERMINISTIC mechanics of the 7 protocol invariants (§13.3). The Gemini 3 Pro
// CARRIER (dose/diagnosis/course CONTENT) is second-tempo, behind the PM T-2
// acceptance gate (§13.5) — where content is carrier-dependent, the response is
// mechanically well-formed and marked `carrier_pending: true`; it is never a fake
// dose. Schemas: docs/mcp_methodist_design.md.
//
// Invariants demonstrable HERE, no LLM: inv.1 mechanical stop-rule (checkpoint N+1
// without recorded GO(N) → returned with reason), inv.2 hash-idempotency (repeat
// hand-in → same response, repeat:true), inv.4 every exchange → a Layer 2 activity
// (A3 applied_instrument/genre), inv.5 escalation → ticket, inv.6/7 dossier_written
// on every writing reply.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { jsonResult } from './shared/helpers.js';
import {
  handinHash,
  getOrCreateDossier,
  hasGo,
  findByHandinHash,
  recordCheckpoint,
  createEscalation,
  getEscalations,
  recordJournalExchange,
} from '@openarx/api';

const CARRIER_NOTE =
  'The methodist carrier (Gemini 3 Pro + methodology) is not yet live (behind the PM T-2 acceptance gate, §13.5). The channel MECHANICS are active; content fields are provisional until the carrier ships.';

function errJson(data: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: true };
}

/** Credential = the token owner (server-bound, §13.2), NOT the free-typed param. */
function credentialOf(extra: unknown, paramFallback: string): { credential: string; portalUserId: string | null } {
  const token = (extra as Record<string, unknown> | undefined)?._portalToken as { userId?: string } | undefined;
  const portalUserId = token?.userId ?? null;
  return { credential: portalUserId ?? paramFallback, portalUserId };
}

/**
 * inv.4 — record the PROCESS exchange in the INTERNAL methodist journal (PM ruling
 * §13.3: process private, outcomes public). NOT the public Layer 2 graph — a public
 * exchange stream would leak the correction-density signal the dossier keeps private.
 * Carries the A3 fields. The four OUTCOME classes go to public Layer 2 activities via
 * recordOutcomeActivity at outcome points (carrier / cycle-9 logic) — never here.
 * Best-effort: a failure never breaks the exchange; the response reports whether it landed.
 */
async function journalExchange(credential: string, tool: string, genre: string, detail: Record<string, unknown>): Promise<boolean> {
  try {
    await recordJournalExchange({ credentialId: credential, tool, genre, detail });
    return true;
  } catch (err) {
    console.error('[methodist] journal write failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function registerMethodistTools(server: McpServer, _ctx: AppContext): void {
  // 2.1 methodist_diagnose
  server.tool(
    'methodist_diagnose',
    'Diagnose a situation → which methodology cycle + entry point + the SIGNS behind the diagnosis (explaining the signs is mandatory, §13.2). Content is carrier-dependent (Gemini 3 Pro); mechanics active, dose provisional until the carrier ships.',
    { question: z.string().min(1).describe("The mentee's situation / question (free text)") },
    async ({ question }, extra) => {
      const { credential } = credentialOf(extra, 'anonymous');
      const journal_recorded = await journalExchange(credential, 'methodist_diagnose', 'diagnosis', { question: question.slice(0, 200) });
      return jsonResult({
        cycle: null,
        entry_point: null,
        diagnosis_signs: [],
        carrier_pending: true,
        note: CARRIER_NOTE,
        journal_recorded,
      });
    },
  );

  // 2.2 methodist_checkpoint — core of the protocol
  server.tool(
    'methodist_checkpoint',
    'Hand in a stage → correction / next-stage dose / GO + a track reply. CORE of the protocol. Mechanical stop-rule: a checkpoint for stage N+1 without a recorded GO(N) is returned with a reason (inv.1). Idempotent: a repeat hand-in (same content) replays the same response (inv.2). Every response reports dossier_written (inv.6/7). Dose CONTENT is carrier-dependent.',
    {
      credential_id: z.string().describe('Advisory — the server binds the credential to the token owner (§13.2)'),
      stage: z.union([z.number(), z.string()]).describe('The stage being handed in'),
      track_note: z.string().describe("The mentee's note on this stage's work"),
      artifacts: z.union([z.record(z.unknown()), z.array(z.unknown())]).describe('Stage artifacts (traces, maps, syntheses)'),
    },
    async ({ credential_id, stage, track_note, artifacts }, extra) => {
      const { credential } = credentialOf(extra, credential_id);
      const stageStr = String(stage);

      // inv.1 mechanical stop-rule: entering stage N+1 requires a recorded GO(N).
      const n = Number(stageStr);
      if (Number.isInteger(n) && n > 1) {
        const prior = String(n - 1);
        if (!(await hasGo(credential, prior))) {
          return errJson({
            error: 'stage_gate',
            reason: `no recorded GO for stage ${prior}; hand in stage ${prior} before entering stage ${stageStr}`,
            stage: stageStr,
          });
        }
      }

      // inv.2 idempotency: a repeat hand-in replays the stored response.
      const hash = handinHash({ credential_id: credential, stage: stageStr, track_note, artifacts });
      const existing = await findByHandinHash(hash);
      if (existing) {
        return jsonResult({ ...existing.response, repeat: true });
      }

      const dossier = await getOrCreateDossier(credential);
      const dossier_written = { stage_recorded: stageStr, go: true, provisional: true };
      const response: Record<string, unknown> = {
        next_dose: {
          stage: Number.isInteger(n) ? n + 1 : `${stageStr}+1`,
          operations: [],
          beacons: [],
          expected_artifacts: [],
          counters_to_keep: [],
          // §13.4: stage 7 (write-path) is ALWAYS full regardless of level.
          checkpoint_mode: stageStr === '7' ? 'full' : dossier.autonomy === 'A2' ? 'batch_note' : 'full',
        },
        autonomy: dossier.autonomy,
        dossier_written,
        carrier_pending: true,
        note: CARRIER_NOTE,
      };

      // Provisional auto-GO on a recorded hand-in (the carrier will make GO conditional
      // on hand-in quality). The stop-rule is still demonstrable: jumping to a stage
      // whose predecessor was never handed in is blocked above.
      const { record } = await recordCheckpoint({ credentialId: credential, stage: stageStr, handinHash: hash, response, go: true });
      const journal_recorded = await journalExchange(credential, 'methodist_checkpoint', 'mentorship', { stage: stageStr });

      // surface any resolved escalation (inv.5) on the next checkpoint
      const escalations = await getEscalations(credential);
      const resolved = escalations.find((e) => e.status !== 'open' && e.resolution);
      if (resolved) response.escalation_resolution = { ticket: resolved.ticket, resolution: resolved.resolution };

      return jsonResult({ ...response, checkpoint_id: record.id, journal_recorded });
    },
  );

  // 2.3 methodist_escalate
  server.tool(
    'methodist_escalate',
    'Escalate above the methodist (PM/human) — the mentee has a standing right to escalate over the methodist\'s head (inv.5). Returns a ticket; the resolution arrives via the next checkpoint response or get_my_development.',
    {
      credential_id: z.string().describe('Advisory — server binds to the token owner'),
      review_run_id: z.string().describe('The run/context the escalation is about'),
      issue: z.string().describe('What is being escalated'),
      class: z.string().describe('construction | methodology | platform (open set — the report-ambiguity channel)'),
    },
    async ({ credential_id, review_run_id, issue, class: klass }, extra) => {
      const { credential } = credentialOf(extra, credential_id);
      const esc = await createEscalation({ credentialId: credential, reviewRunId: review_run_id, issue, klass });
      const journal_recorded = await journalExchange(credential, 'methodist_escalate', 'escalation', { class: klass, review_run_id });
      return jsonResult({ ticket: esc.ticket, status: esc.status, journal_recorded });
    },
  );

  // 2.4 get_my_development
  server.tool(
    'get_my_development',
    'Return the full dossier: autonomy level, cycles passed, patches received, track record — plus open/resolved escalations. The subject sees their dossier IN FULL (inv.6 transparency).',
    { credential_id: z.string().describe('Advisory — server binds to the token owner') },
    async ({ credential_id }, extra) => {
      const { credential } = credentialOf(extra, credential_id);
      const dossier = await getOrCreateDossier(credential);
      const escalations = await getEscalations(credential);
      return jsonResult({ dossier, escalations });
    },
  );

  // 2.5 methodist_course
  server.tool(
    'methodist_course',
    'Training loop: a corpus unit (exercise) → submit a trace → compare to the reference + D-criteria. First course is the TRIZ ladder. Corpus is carrier/methodist-supplied; mechanics active, content provisional until the carrier ships. Optional class narrows the unit to a course class (§13.2 / PM ticket 0488).',
    {
      credential_id: z.string().describe('Advisory — server binds to the token owner'),
      level: z.union([z.number(), z.string()]).describe('Ladder level'),
      class: z.string().optional().describe('Optional course class (open set §9.3): artefact | gate-edge | full-ariz. Absent → by-LEVEL default (backward-compatible). Present → selects the course-unit of that class AT the level. Class semantics owned by the methodist corpus (msi:openarx-methodist).'),
    },
    async ({ credential_id, level, class: klass }, extra) => {
      const { credential } = credentialOf(extra, credential_id);
      const journal_recorded = await journalExchange(credential, 'methodist_course', 'course', { level: String(level), class: klass ?? null });
      return jsonResult({
        exercise: null,
        submission_target: null,
        reference: null,
        D_criteria: [],
        level: String(level),
        ...(klass ? { requested_class: klass } : {}),
        carrier_pending: true,
        note: CARRIER_NOTE,
        journal_recorded,
      });
    },
  );
}
