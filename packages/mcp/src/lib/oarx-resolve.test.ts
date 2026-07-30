import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOarxIdToDocId } from './oarx-resolve.js';

const VALID16 = 'oarx-b04ac9fb2c990f23';
const LEGACY8 = 'oarx-b04ac9fb';

function poolReturning(
  rows: Array<{ id: string }>,
  capture?: (sql: string, params: unknown[]) => void,
): Parameters<typeof resolveOarxIdToDocId>[0] {
  return {
    query: async (text: string, values: unknown[]) => {
      capture?.(text, values);
      return { rows };
    },
  } as unknown as Parameters<typeof resolveOarxIdToDocId>[0];
}

test('16-hex oarx-id → ok with docId (exact-match cond, deleted/listed filtered)', async () => {
  let sql = '';
  const r = await resolveOarxIdToDocId(poolReturning([{ id: 'uuid-1' }], (s) => { sql = s; }), VALID16);
  assert.deepEqual(r, { status: 'ok', docId: 'uuid-1' });
  assert.match(sql, /oarx_id = \$1/);
  assert.match(sql, /deleted_at IS NULL AND status != 'listed'/);
});

test('legacy 8-hex oarx-id → ok via left(oarx_id, 13) prefix', async () => {
  let sql = '';
  const r = await resolveOarxIdToDocId(poolReturning([{ id: 'uuid-2' }], (s) => { sql = s; }), LEGACY8);
  assert.deepEqual(r, { status: 'ok', docId: 'uuid-2' });
  assert.match(sql, /left\(oarx_id, 13\) = \$1/);
});

test('malformed oarx-id → invalid (no query executed)', async () => {
  let ran = false;
  for (const bad of ['not-an-oarx-id', 'oarx-XYZ', 'oarx-b04ac9fb2c990f2', '', '1706.03762']) {
    const r = await resolveOarxIdToDocId(poolReturning([], () => { ran = true; }), bad);
    assert.deepEqual(r, { status: 'invalid' });
  }
  assert.equal(ran, false);
});

test('valid format but no matching row → not_found', async () => {
  const r = await resolveOarxIdToDocId(poolReturning([]), VALID16);
  assert.deepEqual(r, { status: 'not_found' });
});

test('trims + lowercases the id before the query', async () => {
  let params: unknown[] = [];
  const r = await resolveOarxIdToDocId(poolReturning([{ id: 'u' }], (_s, p) => { params = p; }), '  OARX-B04AC9FB2C990F23  ');
  assert.deepEqual(r, { status: 'ok', docId: 'u' });
  assert.equal(params[0], 'oarx-b04ac9fb2c990f23');
});
