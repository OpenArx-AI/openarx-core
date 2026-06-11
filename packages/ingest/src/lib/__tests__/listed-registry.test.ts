/**
 * Unit tests for the per-document registry row/SQL builders (openarx-tvts).
 * Run: pnpm --filter @openarx/ingest test:listed-registry
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  computeArxivOarxId,
  buildListedRows,
  buildListedInsertSql,
  flattenListedRows,
  LISTED_ROW_PARAM_COUNT,
} from '../listed-registry.js';
import type { ArxivEntry } from '../../sources/arxiv-source.js';

function makeEntry(overrides: Partial<ArxivEntry> = {}): ArxivEntry {
  return {
    arxivId: '2502.01234',
    title: 'A Paper About Things',
    authors: [{ name: 'Alice' }, { name: 'Bob' }],
    abstract: 'We study things.',
    categories: ['cs.LG', 'cs.AI'],
    publishedAt: '2025-02-03T18:00:00Z',
    updatedAt: '2025-02-03T18:00:00Z',
    pdfUrl: 'https://arxiv.org/pdf/2502.01234',
    ...overrides,
  };
}

test('computeArxivOarxId matches the canonical 16-hex formula', () => {
  const arxivId = '2502.01234';
  const expected = 'oarx-' + createHash('sha256').update(`arxiv:${arxivId}`).digest('hex').slice(0, 16);
  assert.equal(computeArxivOarxId(arxivId), expected);
  assert.equal(computeArxivOarxId(arxivId).length, 21);
  // Stable across calls (pure function of the id)
  assert.equal(computeArxivOarxId(arxivId), computeArxivOarxId(arxivId));
});

test('legacy 8-hex oarx_id is a prefix of the 16-hex id (migration 029 compat)', () => {
  const arxivId = '2101.11711';
  const legacy = 'oarx-' + createHash('sha256').update(`arxiv:${arxivId}`).digest('hex').slice(0, 8);
  assert.ok(computeArxivOarxId(arxivId).startsWith(legacy));
});

test('16-hex resolves the known prod collision pair', () => {
  // At 8 hex these two papers both hashed to oarx-f629d9b6 (openarx-pc98)
  const a = computeArxivOarxId('2502.15708');
  const b = computeArxivOarxId('2101.11711');
  assert.ok(a.startsWith('oarx-f629d9b6'));
  assert.ok(b.startsWith('oarx-f629d9b6'));
  assert.notEqual(a, b);
});

test('buildListedRows maps listing metadata into row params', () => {
  const rows = buildListedRows([makeEntry({ doi: '10.1234/x', journalRef: 'NeurIPS 2025' })]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.sourceId, '2502.01234');
  assert.equal(r.sourceUrl, 'https://arxiv.org/abs/2502.01234');
  assert.equal(r.title, 'A Paper About Things');
  assert.equal(r.abstract, 'We study things.');
  assert.deepEqual(r.categories, ['cs.LG', 'cs.AI']);
  assert.deepEqual(JSON.parse(r.authorsJson), [{ name: 'Alice' }, { name: 'Bob' }]);
  assert.equal(r.publishedAt?.toISOString(), '2025-02-03T18:00:00.000Z');
  assert.equal(r.oarxId, computeArxivOarxId('2502.01234'));
  assert.deepEqual(JSON.parse(r.externalIdsJson), {
    oarx: computeArxivOarxId('2502.01234'),
    arxiv: '2502.01234',
    doi: '10.1234/x',
    journal_ref: 'NeurIPS 2025',
  });
});

test('buildListedRows omits absent doi/journal_ref from external_ids', () => {
  const [r] = buildListedRows([makeEntry()]);
  const ext = JSON.parse(r.externalIdsJson);
  assert.deepEqual(Object.keys(ext).sort(), ['arxiv', 'oarx']);
});

test('buildListedRows tolerates missing categories and bad dates', () => {
  const [r] = buildListedRows([
    makeEntry({ categories: undefined as unknown as string[], publishedAt: 'not-a-date' }),
  ]);
  assert.deepEqual(r.categories, []);
  assert.equal(r.publishedAt, null);
});

test('buildListedRows deduplicates repeated arxivIds within a batch', () => {
  const rows = buildListedRows([makeEntry(), makeEntry({ title: 'Duplicate Listing' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'A Paper About Things'); // first occurrence wins
});

test('buildListedInsertSql numbers params per row and stays idempotent', () => {
  const sql = buildListedInsertSql(2);
  // Row 1 params $1..$10, row 2 params $11..$20
  assert.match(sql, /\(\$1::uuid, \$2, \$3, \$4, \$5::jsonb, \$6, \$7::text\[\], \$8::timestamptz, \$9::jsonb, \$10\)/);
  assert.match(sql, /\(\$11::uuid, \$12, \$13, \$14, \$15::jsonb, \$16, \$17::text\[\], \$18::timestamptz, \$19::jsonb, \$20\)/);
  assert.equal((sql.match(/::uuid/g) ?? []).length, 2);
  // Idempotency layers: any-version existence guard + conflict no-op
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /d\.source = 'arxiv' AND d\.source_id = v\.source_id/);
  assert.match(sql, /ON CONFLICT \(source, source_id, version\) DO NOTHING/);
  // oarx_id collision guard: 32-bit truncated hash collides at ~1M docs;
  // unique idx_documents_oarx_id is not the ON CONFLICT target, so without
  // this guard one colliding paper aborts the whole multi-row INSERT
  assert.match(sql, /d2\.oarx_id = v\.oarx_id/);
  // Registry semantics: status listed, tier NULL (gate decides at processing)
  assert.match(sql, /'listed'/);
  assert.match(sql, /indexing_tier\s*\)/);
  assert.match(sql, /'\{\}'::jsonb, NULL/);
});

test('flattenListedRows order matches the SQL tuple and param count', () => {
  const rows = buildListedRows([makeEntry()]);
  const flat = flattenListedRows(rows);
  assert.equal(flat.length, LISTED_ROW_PARAM_COUNT);
  const r = rows[0];
  assert.deepEqual(flat, [
    r.id, r.sourceId, r.sourceUrl, r.title, r.authorsJson,
    r.abstract, r.categories, r.publishedAt, r.externalIdsJson, r.oarxId,
  ]);
});
