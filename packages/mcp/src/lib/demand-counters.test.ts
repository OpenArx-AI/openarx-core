/**
 * Tests for demand counter key parsing + doc-id extraction (openarx-1nvk).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemandKey, parseDemandKey, demandDocId } from './demand-counters.js';

const UUID = 'ec67911c-4f21-4ac1-b914-f6166c7a2c83';

test('buildDemandKey / parseDemandKey roundtrip', () => {
  const key = buildDemandKey('2026-06-26', UUID);
  assert.equal(key, `mcp:demand:2026-06-26:${UUID}`);
  assert.deepEqual(parseDemandKey(key), { date: '2026-06-26', docId: UUID });
});

test('parseDemandKey rejects malformed / non-uuid', () => {
  assert.equal(parseDemandKey('mcp:cost:2026-06-26:foo:v1'), null); // wrong prefix
  assert.equal(parseDemandKey('mcp:demand:2026-06-26:not-a-uuid'), null);
  assert.equal(parseDemandKey('mcp:demand:2026-06-26'), null); // no docId
});

test('demandDocId — prefers resolved result, falls back to UUID arg', () => {
  // get_document resolves arxivId → topResults carries the real UUID
  assert.equal(demandDocId({ arxivId: '2405.14831' }, [{ docId: UUID }]), UUID);
  // get_chunks passes a UUID id arg, no topResults
  assert.equal(demandDocId({ id: UUID }, null), UUID);
  assert.equal(demandDocId({ documentId: UUID }, null), UUID);
  // arxivId-only call with no resolved result → cannot attribute → null
  assert.equal(demandDocId({ arxivId: '2405.14831' }, null), null);
  assert.equal(demandDocId({ id: '2405.14831' }, null), null); // non-uuid id
  assert.equal(demandDocId(undefined, undefined), null);
});
