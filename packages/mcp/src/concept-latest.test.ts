/**
 * concept-latest helper — status/body contract for the §19 stale-parent lookup
 * (bead openarx-yurz). The SQL ordering (MAX version) is exercised live; here we
 * pin the helper's mapping from query result → HTTP status + body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConceptLatest, type QueryablePool } from './concept-latest.js';

const CONCEPT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function poolReturning(rows: unknown[]): QueryablePool {
  return { query: async () => ({ rows }) } as unknown as QueryablePool;
}

test('concept-latest: latest row → 200 {id,version,title}', async () => {
  const r = await resolveConceptLatest(poolReturning([{ id: 'doc-9', version: 3, title: 'v3 title' }]), CONCEPT, USER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 'doc-9', version: 3, title: 'v3 title' });
});

test('concept-latest: no owned doc in concept → 404 concept_not_found', async () => {
  const r = await resolveConceptLatest(poolReturning([]), CONCEPT, USER);
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'concept_not_found');
});

test('concept-latest: non-UUID concept_id → 400 bad_request, no DB call', async () => {
  let called = false;
  const pool = { query: async () => { called = true; return { rows: [] }; } } as unknown as QueryablePool;
  const r = await resolveConceptLatest(pool, 'not-a-uuid', USER);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
  assert.equal(called, false);
});

test('concept-latest: non-UUID user_id → 400 bad_request', async () => {
  const r = await resolveConceptLatest(poolReturning([]), CONCEPT, 'nope');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
});

test('concept-latest: DB error → 503 concept_latest_unavailable', async () => {
  const pool = { query: async () => { throw new Error('connection lost'); } } as unknown as QueryablePool;
  const r = await resolveConceptLatest(pool, CONCEPT, USER);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'concept_latest_unavailable');
});
