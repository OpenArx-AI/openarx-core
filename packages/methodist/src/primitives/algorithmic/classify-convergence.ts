// ── classify-convergence v1 (algorithmic · deterministic) ────────────────────
//
// goal: is a pair of records a CONVERGENT finding (independent runs) or a
// potential ERRATUM (same run produced both)?
// in: { record_a, record_b } · out: { class } · access/effects: none (provenance is
// carried on the records — the caller composes read-graph/fetch-run-state upstream).

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface Provenanced {
  run_id: string;
  attester_id?: string;
}
interface In {
  record_a: Provenanced;
  record_b: Provenanced;
}
interface Out {
  class: 'convergent' | 'erratum';
}

export const classifyConvergencePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'classify-convergence',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'classify a record pair as convergent (independent runs) or erratum (same run)',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => {
    const sameRun = inputs.record_a.run_id === inputs.record_b.run_id;
    return { outputs: { class: sameRun ? 'erratum' : 'convergent' } };
  },
);
