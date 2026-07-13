// ── write-graph-records v1 (state · deterministic given id source + clock) ────
//
// goal: ASSEMBLE the graph write-set for a checkpoint, branching BY DATA on the
// verdict (§4). It STAGES (returns `written`); commit-bundle-atomic performs the
// atomic write (§5 staging → atomic commit). Converged shapes w/ methodist 2026-07-08:
//   GO     → the annotated scientific records + a `checkpoint_go` outcome-activity
//            (activity_content: quality + track_note + cycle_context; generated:[claim ids]).
//   RETURN → ONLY a `checkpoint_return` outcome-activity (reasons + corrections +
//            track_note + cycle_context) — NO scientific claim (graph stays methodical
//            work only; the failed attempt is a public FACT, not an unvetted claim).
// verify ANNOTATES each claim's `verification` (VERIFIED|UNVERIFIABLE) — never blocks
// publication (§8 inv-5). Outcome-activity id is content-derived (injected assignId).
//
// in: { records, verdict, verify_status?, language?, hash?, track_note?, run_id, stage?, cycle?, credential_id }
// out: { written } · access/effects: none (assembly; commit writes).

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';
import { asRecordArray } from '../shared.js';
import type { AssignId } from '../transform/resolve-local-ids.js';
import type { Clock } from './update-dossier.js';

interface ResolvedRecord {
  record_type: string;
  record: Record<string, unknown>;
}
interface Verdict {
  verdict?: 'GO' | 'RETURN';
  quality?: unknown;
  reasons?: unknown;
  corrections?: unknown;
}
interface In {
  /** Threaded through bare slot refs ($resolved → $canon → $guarded), so it arrives
   *  as a wrapper object ({records:[...]}) — unwrapped via asRecordArray, same as the
   *  other record-flow primitives. Bare array also accepted. */
  records: unknown;
  verdict: Verdict;
  verify_status?: unknown;
  language?: unknown;
  hash?: unknown;
  track_note?: unknown;
  run_id: string;
  stage?: unknown;
  cycle?: unknown;
  credential_id: string;
}
interface Out {
  written: ResolvedRecord[];
}

export function makeWriteGraphRecords(assignId: AssignId, now: Clock): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'write-graph-records',
      version: 'v1',
      kind: 'state',
      goal: 'assemble the verdict-branched graph write-set (claim+stamp on GO / path-fact on RETURN)',
      access: [],
      effects: [], // staged; commit-bundle-atomic performs the atomic write (§5)
      determinism: 'deterministic',
    },
    ({ inputs }) => {
      const v = inputs.verdict.verdict;
      const prefix = inputs.credential_id;
      const cycle_context = { cycle_type: inputs.cycle ?? null, run_id: inputs.run_id, stage_id: inputs.stage ?? null };
      const written: ResolvedRecord[] = [];

      if (v === 'GO') {
        // publish the scientific records, annotated (verify/language), each with an id.
        const claimIds: string[] = [];
        for (const r of asRecordArray(inputs.records)) {
          const content = r.record.content && typeof r.record.content === 'object' ? (r.record.content as Record<string, unknown>) : undefined;
          const rec: Record<string, unknown> = {
            ...r.record,
            // author = the authenticated mentee (boundary-1) — authoritative, not
            // self-declared; the methodist only mentors (applied_instrument on the activity).
            attester_id: inputs.credential_id,
            verification: inputs.verify_status ?? r.record.verification ?? null,
            language: inputs.language ?? r.record.language ?? null,
            // eied (§12.7): denorm the schema's indexed_properties to TOP-LEVEL native scalars
            // so graphMapping indexes them (findability by run/status/current-graph).
            //  • run_id — server-sourced from THIS run (denorm of cycle_context.run_id). It is a
            //    PROCESS field → read-stripped by the §12.5-bis PROCESS_ID_KEYS rule (scientific-
            //    reads): internal index only, never agent-facing.
            //  • is_superseded — false on a fresh record (server-materialized; flips on §7.6 supersede).
            run_id: inputs.run_id,
            is_superseded: false,
          };
          // claim_status = the led's declared epistemic kind (ClaimContent.claim_status, an open
          // enum — KNOWN_CLAIM_STATUSES). Denorm to top-level for the index; leave unset if the
          // mentee didn't declare it (no fabricated default — the enum has no neutral initial).
          if (r.record_type === 'claim' && typeof content?.claim_status === 'string') {
            rec.claim_status = content.claim_status;
          }
          const id = typeof rec.id === 'string' ? rec.id : assignId(rec, r.record_type, prefix);
          rec.id = id;
          written.push({ record_type: r.record_type, record: rec });
          if (r.record_type === 'claim') claimIds.push(id);
        }
        // the outcome-activity IS the quality stamp (§12.5 converged): one node.
        const act: Record<string, unknown> = {
          activity_type: 'checkpoint_go',
          attester_id: inputs.credential_id,
          attested_at: now(),
          wasAssociatedWith: [inputs.credential_id],
          generated: claimIds,
          activity_content: { quality: inputs.verdict.quality ?? null, track_note: inputs.track_note ?? null, cycle_context },
          applied_instrument: 'methodist',
          genre: 'checkpoint',
          // eied: indexed_properties as top-level native scalars (run_id read-stripped §12.5-bis).
          run_id: inputs.run_id,
          is_superseded: false,
        };
        act.id = assignId(act, 'activity', prefix);
        written.push({ record_type: 'activity', record: act });
      } else {
        // RETURN — record only the path/fact; NO claim.
        const act: Record<string, unknown> = {
          activity_type: 'checkpoint_return',
          attester_id: inputs.credential_id,
          attested_at: now(),
          wasAssociatedWith: [inputs.credential_id],
          generated: [],
          activity_content: {
            reasons: inputs.verdict.reasons ?? null,
            corrections: inputs.verdict.corrections ?? null,
            track_note: inputs.track_note ?? null,
            cycle_context,
          },
          applied_instrument: 'methodist',
          genre: 'checkpoint',
          // eied: indexed_properties as top-level native scalars (run_id read-stripped §12.5-bis).
          run_id: inputs.run_id,
          is_superseded: false,
        };
        act.id = assignId(act, 'activity', prefix);
        written.push({ record_type: 'activity', record: act });
      }

      // ref-integrity: no unresolved bundle-local refs may reach the graph.
      for (const w of written) {
        for (const [k, val] of Object.entries(w.record)) {
          if (typeof val === 'string' && val.startsWith('_:')) {
            throw new RuntimeError('bad-output', `unresolved local ref '${val}' in ${w.record_type}.${k}`);
          }
        }
      }

      // methodist write-path observability (Vlad): received (submission) vs staged (write-set)
      // record-type breakdown — a relation that is submitted but never staged (dropped upstream, or
      // only on GO) is visible here vs one that reaches the write-set. RETURN stages no claims.
      const countByType = (arr: Array<{ record_type: string }>): Record<string, number> =>
        arr.reduce<Record<string, number>>((m, r) => ((m[r.record_type] = (m[r.record_type] ?? 0) + 1), m), {});
      console.error(
        JSON.stringify({
          at: 'write-graph-records',
          verdict: v,
          received: countByType(asRecordArray(inputs.records)),
          staged: countByType(written),
        }),
      );

      return { outputs: { written } };
    },
  );
}
