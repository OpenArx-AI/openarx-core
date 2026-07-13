// ── commit-bundle-atomic v1 (state · deterministic) ──────────────────────────
//
// goal: atomically commit the staged write-set (all-or-nothing, §5). Wave-v2 form:
// takes `written` from write-graph-records (records already carry content-derived
// ids) and commits them. Atomicity = validate-ALL-then-write: any invalid staged
// record aborts the whole commit (nothing written; no partial graph state).
// in: { written } · out: { committed, bundle_id } · access: none · effects: graph.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

interface ResolvedRecord {
  record_type: string;
  record: Record<string, unknown>;
}
interface In {
  /** write-graph-records outputs { written: [...] }, threaded as the bare slot ref
   *  $written — so it arrives as that wrapper. A bare array is also accepted. */
  written: unknown;
}
interface Out {
  committed: ResolvedRecord[];
  bundle_id: string;
}

/** Unwrap the staged set whether it arrives bare or as { written: [...] }. */
function stagedRecords(input: unknown): ResolvedRecord[] {
  if (Array.isArray(input)) return input as ResolvedRecord[];
  if (input && typeof input === 'object' && Array.isArray((input as { written?: unknown }).written)) {
    return (input as { written: ResolvedRecord[] }).written;
  }
  return [];
}

export const commitBundleAtomicPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'commit-bundle-atomic',
    version: 'v1',
    kind: 'state',
    goal: 'atomically commit the staged write-set (all-or-nothing)',
    access: [],
    effects: ['graph'],
    determinism: 'deterministic',
  },
  async ({ inputs, ctx }) => {
    const written = stagedRecords(inputs.written);
    // Phase 1 — validate every staged record has an id; a single failure aborts.
    for (const w of written) {
      if (typeof w.record?.id !== 'string' || (w.record.id as string).length === 0) {
        throw new RuntimeError('bad-output', 'staged record missing id — commit aborted, nothing written');
      }
    }
    // Phase 2 — write all (only reached when the whole batch is valid). §12.8: commit the edge
    // ENDPOINTS (claims/metrics) BEFORE relations, so a relation's companion edge always finds its
    // same-bundle claim endpoints (the store's OPTIONAL MATCH succeeds) — a dangling relation does
    // NOT arise by construction. Bundles reference records; activities are outcome nodes. V8 sort is
    // stable, so within-tier submission order is preserved.
    const TIER: Record<string, number> = { claim: 0, metric: 0, relation: 1, bundle: 2, activity: 3 };
    const ordered = [...written].sort((a, b) => (TIER[a.record_type] ?? 1) - (TIER[b.record_type] ?? 1));
    // methodist write-path observability (Vlad): the type-breakdown actually committed to the graph.
    console.error(
      JSON.stringify({
        at: 'commit-bundle-atomic',
        committing: ordered.reduce<Record<string, number>>((m, w) => ((m[w.record_type] = (m[w.record_type] ?? 0) + 1), m), {}),
      }),
    );
    const write = ctx.write('graph');
    const ids: string[] = [];
    for (const w of ordered) {
      const id = w.record.id as string;
      await write.put(id, w);
      ids.push(id);
    }
    const bundle_id = `bundle:${ids.length}:${[...ids].sort()[0] ?? 'empty'}`;
    return { outputs: { committed: written, bundle_id } };
  },
);
