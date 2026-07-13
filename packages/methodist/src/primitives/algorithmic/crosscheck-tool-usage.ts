// ── crosscheck-tool-usage v1 (algorithmic · deterministic) ───────────────────
//
// goal: reconcile an agent's CLAIMED tool usage against the system call log (U7).
// in: { claimed_usage, run_id } · out: { consistent, discrepancies[] } · access: journal · effects: none.
// Discrepancy = a tool the agent claimed but the log doesn't show, or vice versa.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  claimed_usage: string[];
  run_id: string;
}
interface Out {
  consistent: boolean;
  discrepancies: string[];
}

/** Journal entry shape this primitive reads. */
interface JournalEntry {
  run_id?: string;
  tool?: string;
}

export const crosscheckToolUsagePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'crosscheck-tool-usage',
    version: 'v1',
    kind: 'algorithmic',
    goal: "reconcile an agent's claimed tool usage against the system call log",
    access: ['journal'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    // Scope the read to this run (a spec the store MAY use to avoid a full scan);
    // in-memory stores ignore it and the run_id filter below still applies.
    const entries = (await ctx.read('journal').list({ run_id: inputs.run_id })) as JournalEntry[];
    const logged = new Set(
      entries.filter((e) => e.run_id === inputs.run_id && typeof e.tool === 'string').map((e) => e.tool as string),
    );
    const claimed = new Set(inputs.claimed_usage);
    const discrepancies: string[] = [];
    for (const c of claimed) if (!logged.has(c)) discrepancies.push(`claimed_not_logged:${c}`);
    for (const l of logged) if (!claimed.has(l)) discrepancies.push(`logged_not_claimed:${l}`);
    discrepancies.sort();
    return { outputs: { consistent: discrepancies.length === 0, discrepancies } };
  },
);
