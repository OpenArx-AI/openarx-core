// ── search-semantic v1 (retrieval · deterministic at a fixed index) ──────────
//
// goal: semantically nearest records (vector ANN + filters).
// in: { query_text?, query_vector?, filters?, k } · out: { candidates:[{id,score}] }
// access: vector · effects: none.
// The query embedder is INJECTED (real path: gemini vector) so tests either pass
// query_vector directly or stub the embedder — the ANN/filter/top-k is pure.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

/** Injected embedder. Async-capable: real embedding is a network call (embed-service);
 *  sync stubs (tests) still satisfy the union. */
export type Embed = (text: string) => number[] | Promise<number[]>;

interface Point {
  id: string;
  vector: number[];
  [field: string]: unknown;
}
interface In {
  query_text?: string;
  query_vector?: number[];
  filters?: Record<string, unknown>;
  k: number;
}
interface Out {
  candidates: Array<{ id: string; score: number }>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function makeSearchSemantic(embed: Embed): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'search-semantic',
      version: 'v1',
      kind: 'retrieval',
      goal: 'vector ANN over the index with filters, top-k',
      access: ['vector'],
      effects: [],
      determinism: 'deterministic',
    },
    async ({ inputs, ctx }) => {
      const qv = inputs.query_vector ?? (inputs.query_text !== undefined ? await embed(inputs.query_text) : undefined);
      if (!qv) throw new RuntimeError('bad-output', 'search-semantic needs query_vector or query_text');
      const filters = inputs.filters ?? {};
      const points = (await ctx.read('vector').list()) as Point[];
      const candidates = points
        .filter((p) => Object.entries(filters).every(([key, val]) => p[key] === val))
        .map((p) => ({ id: p.id, score: cosine(qv, p.vector) }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, inputs.k);
      return { outputs: { candidates } };
    },
  );
}
