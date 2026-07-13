// ── threshold-zone v1 (algorithmic · deterministic) ──────────────────────────
//
// goal: map a score to an action zone.
// in: { score }, params: { thresholds } · out: { zone: 'auto'|'review'|'reject' } · access/effects: none.
// score ≥ auto_min → auto; ≥ review_min → review; else reject (thresholds from methodology).

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  score: number;
}
interface Params {
  thresholds: { auto_min: number; review_min: number };
}
interface Out {
  zone: 'auto' | 'review' | 'reject';
}

export const thresholdZonePrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'threshold-zone',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'map a score to auto/review/reject by methodology thresholds',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs, params }) => {
    const { auto_min, review_min } = params.thresholds;
    const zone = inputs.score >= auto_min ? 'auto' : inputs.score >= review_min ? 'review' : 'reject';
    return { outputs: { zone } };
  },
);
