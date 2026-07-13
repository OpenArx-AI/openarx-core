// ── append-journal v1 (state · deterministic) ────────────────────────────────
//
// goal: immutable record of an exchange/activity.
// in: { run_id, entry } · out: { entry_id } · access: none · effects: append-only journal.
// The runtime forbids update/delete on the journal handle (runtime §5).

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  run_id: string;
  event: string;
  payload: unknown;
}
interface Out {
  entry_id: string;
}

export const appendJournalPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'append-journal',
    version: 'v1',
    kind: 'state',
    goal: 'append an immutable journal entry',
    access: [],
    effects: ['journal'],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const { id } = await ctx.write('journal').append({ run_id: inputs.run_id, event: inputs.event, payload: inputs.payload });
    return { outputs: { entry_id: id } };
  },
);
