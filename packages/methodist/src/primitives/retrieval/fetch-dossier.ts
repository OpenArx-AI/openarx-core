// ── fetch-dossier v1 (retrieval · deterministic) ─────────────────────────────
//
// goal: the competence map (dossier) for an agent.
// in: { agent_id } · out: { dossier } · access: dossier · effects: none.
// A missing dossier is a valid "no" → returned (the methodology decides).

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  credential_id: string;
}
interface Out {
  credential_id: string;
  /** the flat competence map (the ONLY thing fed to the model, §8.7) — $dossier.map */
  map: unknown;
  present: boolean;
}

export const fetchDossierPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'fetch-dossier',
    version: 'v1',
    kind: 'retrieval',
    goal: 'fetch an agent competence dossier by id',
    access: ['dossier'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    // Only the flat competence MAP enters the model (§8.7); expose it at $dossier.map.
    const map = await ctx.read('dossier').get(inputs.credential_id);
    if (map === undefined) {
      return { control: 'returned', outputs: { credential_id: inputs.credential_id, map: {}, present: false } };
    }
    return { outputs: { credential_id: inputs.credential_id, map, present: true } };
  },
);
