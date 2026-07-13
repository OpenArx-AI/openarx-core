// ── filter-latest-only v1 (algorithmic · deterministic) ──────────────────────
//
// goal: keep only current (non-superseded) records.
// in: { records } · out: { records_latest } · effects: none.
// Each record carries its superseded_by (read-graph upstream); a non-empty
// superseded_by means the record has been replaced → drop it.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface LatestRecord {
  id: string;
  superseded_by?: string | null;
}
interface In {
  records: LatestRecord[];
}
interface Out {
  records_latest: LatestRecord[];
}

export const filterLatestOnlyPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'filter-latest-only',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'keep only records whose superseded_by is empty (the current ones)',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => ({
    outputs: { records_latest: inputs.records.filter((r) => !r.superseded_by) },
  }),
);
