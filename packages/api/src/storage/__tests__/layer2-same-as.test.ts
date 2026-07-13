/**
 * §7.6 P2 — same_as clustering (transitive closure) + canonical election.
 * Pure logic, no DB. Locks the collapse primitive's core behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSameAsClusters, electCanonicalId, type CanonicalElectRow } from '../layer2-same-as.js';

const C = (n: number) => `agent:x:claim:${String(n).padStart(64, '0')}`;

test('buildSameAsClusters — transitive closure merges chained edges into one cluster', () => {
  // 1-2, 2-3 → {1,2,3}; 4-5 → {4,5}; 6 has no edge → singleton (absent from maps)
  const { rootOf, membersOf, degreeOf } = buildSameAsClusters([
    { a: C(1), b: C(2) },
    { a: C(2), b: C(3) },
    { a: C(4), b: C(5) },
  ]);
  // 1,2,3 share one root
  assert.equal(rootOf.get(C(1)), rootOf.get(C(3)));
  assert.equal(rootOf.get(C(2)), rootOf.get(C(3)));
  // 4,5 share a DIFFERENT root
  assert.notEqual(rootOf.get(C(1)), rootOf.get(C(4)));
  // exactly two clusters, sizes 3 and 2
  const sizes = [...membersOf.values()].map((m) => m.length).sort();
  assert.deepEqual(sizes, [2, 3]);
  // 6 is a singleton — not present
  assert.equal(rootOf.get(C(6)), undefined);
  // degree: 2 (middle of chain) has 2 neighbours; 1 and 3 have 1
  assert.equal(degreeOf.get(C(2)), 2);
  assert.equal(degreeOf.get(C(1)), 1);
});

test('buildSameAsClusters — cycles do not loop, mirror edges dedup', () => {
  const { membersOf } = buildSameAsClusters([
    { a: C(1), b: C(2) },
    { a: C(2), b: C(1) }, // mirror
    { a: C(2), b: C(3) },
    { a: C(3), b: C(1) }, // closes a cycle
  ]);
  const clusters = [...membersOf.values()];
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0], [C(1), C(2), C(3)]);
});

const row = (n: number, over: Partial<CanonicalElectRow> = {}): CanonicalElectRow => ({
  id: C(n),
  attested_at: '2026-07-01T12:00:00Z',
  verification: null,
  content: { claim_strength: 0.5 },
  ...over,
});

test('electCanonicalId — verified beats everything else', () => {
  const rows = [
    row(1, { content: { claim_strength: 0.9 }, attested_at: '2026-01-01T00:00:00Z' }), // strong + oldest
    row(2, { verification: { outcome: 'VERIFIED' } }), // verified — must win
  ];
  assert.equal(electCanonicalId(rows, new Map()), C(2));
});

test('electCanonicalId — among unverified, higher convergent-degree wins', () => {
  const rows = [row(1), row(2)];
  const degree = new Map([[C(1), 1], [C(2), 3]]);
  assert.equal(electCanonicalId(rows, degree), C(2));
});

test('electCanonicalId — degree tie → evidence-strength → earliest → id', () => {
  const degree = new Map([[C(1), 2], [C(2), 2], [C(3), 2]]);
  // strength decides first
  assert.equal(
    electCanonicalId([row(1, { content: { claim_strength: 0.3 } }), row(2, { content: { claim_strength: 0.8 } })], degree),
    C(2),
  );
  // equal strength → earliest attested_at
  assert.equal(
    electCanonicalId(
      [row(1, { attested_at: '2026-05-01T00:00:00Z' }), row(2, { attested_at: '2026-02-01T00:00:00Z' })],
      degree,
    ),
    C(2),
  );
  // fully tied → lowest id (deterministic)
  assert.equal(electCanonicalId([row(3), row(1), row(2)], degree), C(1));
});
