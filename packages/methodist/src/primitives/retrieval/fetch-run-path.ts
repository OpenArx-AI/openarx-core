// ── fetch-run-path v1 (retrieval · reads journal) ────────────────────────────
//
// §12.1-bis: the run's PATH — its typed path-events (checkpoint_go / checkpoint_return
// / report_need / dose_issued / …) emitted by update-run-state (the SINGLE path-event
// writer, contracts 0183). Normalizes the run-scoped journal into [{type, stage?, ts}]
// — the shape check-stop-rule + derive-run-status derive prev-GO / status from. Tool-log
// entries (anti-gaming, migration 048) are excluded — they carry a `tool`, not an `event`,
// and are not path-events.
// in: { run_id } · out: { path_events } · access: journal · effects: none.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface JournalEntry {
  event?: string | null;
  tool?: string | null;
  payload?: unknown;
  created_at?: string;
  ts?: string;
}
interface In {
  run_id: string;
}
interface PathEvent {
  type: string;
  stage?: number;
  ts?: string;
}
interface Out {
  path_events: PathEvent[];
}

export const fetchRunPathPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'fetch-run-path',
    version: 'v1',
    kind: 'retrieval',
    goal: "read the run's typed path-events from the journal (excluding tool-log), normalized for status/GO derivation",
    access: ['journal'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const entries = (await ctx.read('journal').list({ run_id: inputs.run_id })) as JournalEntry[];
    const path_events: PathEvent[] = entries
      .filter((e) => e.tool == null && typeof e.event === 'string' && e.event.length > 0)
      .map((e) => {
        const p = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {};
        return { type: e.event as string, stage: typeof p.stage === 'number' ? p.stage : undefined, ts: e.created_at ?? e.ts };
      });
    return { outputs: { path_events } };
  },
);
