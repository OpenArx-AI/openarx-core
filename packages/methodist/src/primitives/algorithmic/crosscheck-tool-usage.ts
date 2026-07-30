// ── crosscheck-tool-usage v1 (algorithmic · deterministic) ───────────────────
//
// goal: reconcile an agent's CLAIMED tool usage against the system call log (U7)
// and CLASSIFY the result into a fail-CLOSED §8-inv4 enforcement verdict (contracts
// codification 7d37839, openarx-zw61). The methodology GATES on the classification:
//   fabrication  → HARD transparent-block   (claimed a tool that a NON-EMPTY log doesn't show)
//   inconclusive → fail-closed re-auth      (log entirely empty/unmatched OR journal read-fault —
//                                            NOT an accusation; likely keying/infra, retry)
//   under_report → advisory WARN, proceed   (used tools not claimed — benign, fork-A)
//   pass         → proceed                  (claimed == logged, incl empty-empty / legit-0)
//
// FAIL-CLOSED (was fail-OPEN — zw61): two zw61 holes are closed HERE:
//   [W1] a non-array `claimed_usage` (mentee payload, bound RAW) is a shape contract-violation
//        → bad-output REJECT (§6 native abort), NOT `new Set(non-array)`→TypeError→internal→
//        failed→interpreter-skips→model-GO (self-report silently accepted).
//   [read-fault] a journal read fault is caught → inconclusive(read_fault), NOT an uncaught
//        throw that would surface as internal→failed→fail-open.
// The primitive only CLASSIFIES; the deterministic block/re-auth is the methodology gate on
// these outputs (a `failed`/gate-less step would fail open — interpreter aborts only on a gate
// or a `rejected` outcome).
//
// in: { claimed_usage, run_id } · out: { consistent, discrepancies[], verdict, reason_code?,
//   block_fabrication, inconclusive, warn_under_report } · access: journal · effects: none.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

interface In {
  /** mentee-supplied, bound RAW ($input.payload.claimed_usage) — NOT trusted as string[];
   *  validated at runtime (W1). */
  claimed_usage: unknown;
  run_id: string;
}

/** §8-inv4 enforcement classification (fork-A: fabrication HARD-block, under-report WARN). */
type Verdict = 'pass' | 'under_report' | 'fabrication' | 'inconclusive';

interface Out {
  /** back-compat advisory signal: true iff claimed == logged exactly. */
  consistent: boolean;
  discrepancies: string[];
  /** the enforcement classification the methodology gates on. */
  verdict: Verdict;
  /** only on inconclusive: empty_log (possible keying → re-establish credential + re-submit)
   *  vs read_fault (infra → retry). Drives the re-auth response, not an accusation. */
  reason_code?: 'empty_log' | 'read_fault';
  // Convenience booleans for the methodology gate `when` conditions (one gate per terminal outcome).
  block_fabrication: boolean;
  inconclusive: boolean;
  warn_under_report: boolean;
}

/** Journal entry shape this primitive reads. */
interface JournalEntry {
  run_id?: string;
  tool?: string;
}

function classify(claimed: Set<string>, logged: Set<string>): { verdict: Verdict; reason_code?: 'empty_log' } {
  const claimedNotLogged = [...claimed].some((c) => !logged.has(c));
  const loggedNotClaimed = [...logged].some((l) => !claimed.has(l));
  // fabrication = claimed a tool NOT in a NON-EMPTY log. An ENTIRELY empty log with claims is
  // NOT fabrication (note-iii): an empty log is most likely a keying-divergence (fc7f5f6), so it
  // is inconclusive → re-auth, never an accusation. under-report (logged⊄claimed only) is benign.
  if (claimedNotLogged && logged.size === 0) return { verdict: 'inconclusive', reason_code: 'empty_log' };
  if (claimedNotLogged) return { verdict: 'fabrication' };
  if (loggedNotClaimed) return { verdict: 'under_report' };
  return { verdict: 'pass' };
}

function out(verdict: Verdict, discrepancies: string[], run_id: string, reason_code?: 'empty_log' | 'read_fault'): { outputs: Out } {
  // observability (§8-inv4 item 4): every crosscheck logs its enforcement outcome so a
  // block/warn/re-auth is auditable (tool NAMES omitted — only counts, to keep the line lean).
  console.error(
    JSON.stringify({ at: 'crosscheck-tool-usage', run_id, verdict, reason_code: reason_code ?? null, discrepancies: discrepancies.length }),
  );
  return {
    outputs: {
      consistent: discrepancies.length === 0,
      discrepancies,
      verdict,
      reason_code,
      block_fabrication: verdict === 'fabrication',
      inconclusive: verdict === 'inconclusive',
      warn_under_report: verdict === 'under_report',
    },
  };
}

export const crosscheckToolUsagePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'crosscheck-tool-usage',
    version: 'v1',
    kind: 'algorithmic',
    goal: "reconcile an agent's claimed tool usage against the system call log and classify the enforcement verdict",
    access: ['journal'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    // [W1] type-guard: claimed_usage is bound RAW from the mentee payload. Reject ONLY a
    // PRESENT-but-malformed value (non-array object/usage-map/number/string, or an array with a
    // non-string element) — a shape contract-violation → bad-output REJECT (∈ REJECTED_CODES → §6
    // native abort → fail-CLOSED), NOT a `new Set(non-array)` TypeError→internal→failed→fail-open.
    // ABSENT (undefined/null — or nested-in-submission, leaving the top-level $input.payload.
    // claimed_usage sibling undefined) is LEGIT: the checkpoint payload schema marks claimed_usage
    // OPTIONAL, so absence = "claimed nothing" ([]) → the crosscheck yields at most under_report
    // (advisory), NEVER a hard reject. The gaming signal is PRESENT-but-non-array (a fabricated
    // usage map/count), NOT absence. (Fixes the zw61/v1.19 regression where absent/nested
    // claimed_usage hard-rejected legit checkpoints — a schema↔guard mismatch.)
    const rawClaimed = inputs.claimed_usage;
    if (rawClaimed !== undefined && rawClaimed !== null && (!Array.isArray(rawClaimed) || !rawClaimed.every((t) => typeof t === 'string'))) {
      throw new RuntimeError('bad-output', 'claimed_usage, when provided, must be an array of tool-name strings');
    }
    const claimed = new Set(Array.isArray(rawClaimed) ? (rawClaimed as string[]) : []);

    // The journal read can fault (Neo4j/PG down). A read-fault must NOT fail-open (silently drop
    // the check): classify inconclusive(read_fault) → the gate fail-closes to re-auth/retry. Only
    // the read is guarded — the pure set-comparison below cannot fault.
    let logged: Set<string>;
    try {
      const entries = (await ctx.read('journal').list({ run_id: inputs.run_id })) as JournalEntry[];
      logged = new Set(
        entries.filter((e) => e.run_id === inputs.run_id && typeof e.tool === 'string').map((e) => e.tool as string),
      );
    } catch {
      return out('inconclusive', ['read_fault'], inputs.run_id, 'read_fault');
    }

    const discrepancies: string[] = [];
    for (const c of claimed) if (!logged.has(c)) discrepancies.push(`claimed_not_logged:${c}`);
    for (const l of logged) if (!claimed.has(l)) discrepancies.push(`logged_not_claimed:${l}`);
    discrepancies.sort();

    const { verdict, reason_code } = classify(claimed, logged);
    return out(verdict, discrepancies, inputs.run_id, reason_code);
  },
);
