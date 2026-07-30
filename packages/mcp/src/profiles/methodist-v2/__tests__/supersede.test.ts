// Supersede derivation (openarx-z2bj). The defect being fixed was silent — latest_only filtered
// nothing and the surface answered is_superseded:false about replaced records — so these tests are
// written to fail in the SILENT direction too: a chain that stops one hop short, and a fork resolved
// by picking one head, both look like success unless asserted against.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The graph is faked at the driver boundary: these tests are about the derivation logic (chain,
// fork, cycle), not about Neo4j. The query under test matches `"supersedes":"<id>"` inside the
// newer claim's _data, so the fake indexes the same way.
const graph = new Map<string, string[]>(); // superseded id → ids of the records superseding it

const fakeDriver = {
  session: () => ({
    run: async (_cypher: string, params: Record<string, unknown>) => ({
      records: (params.ids as string[])
        .filter((id) => (graph.get(id)?.length ?? 0) > 0)
        .map((id) => ({
          get: (k: string) => (k === 'superseded' ? id : graph.get(id)),
        })),
    }),
    close: async () => {},
  }),
};

import { deriveSupersessors as derive, resolveSupersedeHead as resolveHead } from '../supersede.js';

// Bind the double once so each call site reads like the production one.
const deriveSupersessors = (ids: string[]) => derive(ids, fakeDriver);
const resolveSupersedeHead = (id: string) => resolveHead(id, fakeDriver);

function reset(pairs: Array<[string, string[]]>): void {
  graph.clear();
  for (const [k, v] of pairs) graph.set(k, v);
}

test('a claim with no supersessor is current', async () => {
  reset([]);
  const m = await deriveSupersessors(['A']);
  assert.equal(m.get('A'), undefined);
  const head = await resolveSupersedeHead('A');
  assert.deepEqual(head, { id: 'A', followedChain: false, ambiguous: false, heads: ['A'], degraded: false });
});

test('★ the chain is followed to the HEAD, not one hop — a one-hop answer names an already-replaced record', async () => {
  // C supersedes A, A supersedes B. Asking about B must answer C.
  reset([
    ['B', ['A']],
    ['A', ['C']],
  ]);
  const head = await resolveSupersedeHead('B');
  assert.equal(head.id, 'C', 'must walk past A, which is itself superseded');
  assert.equal(head.followedChain, true);
  assert.equal(head.ambiguous, false);
});

test('★ a FORK is reported, never resolved silently', async () => {
  // Two records correct the same one: there is no single current version.
  reset([['A', ['X', 'Y']]]);
  const head = await resolveSupersedeHead('A');
  assert.equal(head.ambiguous, true, 'the caller must be told there are competing corrections');
  assert.deepEqual([...head.heads].sort(), ['X', 'Y']);
});

test('a fork resolves each branch to ITS head before reporting', async () => {
  // A is superseded by X and Y; Y is itself superseded by Z → the candidates are X and Z.
  reset([
    ['A', ['X', 'Y']],
    ['Y', ['Z']],
  ]);
  const head = await resolveSupersedeHead('A');
  assert.equal(head.ambiguous, true);
  assert.deepEqual([...head.heads].sort(), ['X', 'Z'], 'Y is stale and must not be offered');
});

test('a cycle terminates and is reported as degraded rather than looping', async () => {
  reset([
    ['A', ['B']],
    ['B', ['A']],
  ]);
  const head = await resolveSupersedeHead('A');
  assert.equal(head.degraded, true, 'a cut chain must say the answer is degraded, not look clean');
});

test('a self-supersede is ignored as malformed, not treated as a chain', async () => {
  reset([['A', ['A']]]);
  const m = await deriveSupersessors(['A']);
  assert.equal(m.get('A'), undefined);
  const head = await resolveSupersedeHead('A');
  assert.equal(head.id, 'A');
  assert.equal(head.degraded, false);
});

test('a batch answers per id, and current claims are simply absent from the map', async () => {
  reset([['A', ['X']]]);
  const m = await deriveSupersessors(['A', 'B', 'C']);
  assert.deepEqual(m.get('A'), ['X']);
  assert.equal(m.get('B'), undefined);
  assert.equal(m.get('C'), undefined);
});
