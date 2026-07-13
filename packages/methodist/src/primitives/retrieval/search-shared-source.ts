// ── search-shared-source v1 (retrieval · deterministic) ──────────────────────
//
// goal: candidates that cite the same source (and, if given, overlap a fragment).
// in: { source_uri, fragment? } · out: { candidates } · access: source-index · effects: none.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface SourceEntry {
  id: string;
  fragment?: string;
}
interface In {
  source_uri: string;
  fragment?: string;
}
interface Out {
  candidates: SourceEntry[];
}

function overlaps(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

export const searchSharedSourcePrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'search-shared-source',
    version: 'v1',
    kind: 'retrieval',
    goal: 'find records sharing a source_uri, optionally overlapping a fragment',
    access: ['source-index'],
    effects: [],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const entries = ((await ctx.read('source-index').get(inputs.source_uri)) as SourceEntry[] | undefined) ?? [];
    const candidates =
      inputs.fragment === undefined
        ? entries
        : entries.filter((e) => e.fragment !== undefined && overlaps(e.fragment, inputs.fragment!));
    return { outputs: { candidates } };
  },
);
