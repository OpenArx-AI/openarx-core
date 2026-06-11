/**
 * R1 invariant (registry-driven ingest, openarx-j173): a download landing on
 * an existing row is a read-modify-write PARTIAL update — it may only touch
 * fields the download step owns. Fields the download code does not know
 * about (operator marks, future enrichments, external_ids.oarx_legacy …)
 * must survive listed → downloaded untouched.
 *
 * Run: pnpm --filter @openarx/ingest test:download-rmw
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLY_DOWNLOAD_SUCCESS_SQL } from '@openarx/api';

/** Columns the download step OWNS — the only ones the UPDATE may SET. */
const OWNED_COLUMNS = [
  'status', 'title', 'authors', 'abstract', 'categories',
  'published_at', 'source_url', 'raw_content_path', 'sources',
  'source_format', 'structured_content', 'licenses', 'license',
  'external_ids',
];

/** Columns that must NEVER appear in the SET list. */
const PROTECTED_COLUMNS = [
  'id', 'version', 'created_at', 'concept_id', 'oarx_id', 'source_id',
  'processing_log', 'provenance', 'retry_count', 'indexing_tier',
  'processing_cost', 'deleted_at', 'deletion_reason', 'keywords',
  'portal_metadata', 'embargo_until',
];

function setColumns(sql: string): string[] {
  const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
  // column name = identifier immediately before '='
  return [...setClause.matchAll(/(\w+)\s*=/g)].map((m) => m[1]);
}

test('applyDownloadSuccess SET list covers exactly the download-owned columns', () => {
  const cols = setColumns(APPLY_DOWNLOAD_SUCCESS_SQL);
  assert.deepEqual([...cols].sort(), [...OWNED_COLUMNS].sort());
});

test('applyDownloadSuccess never touches protected columns', () => {
  const cols = new Set(setColumns(APPLY_DOWNLOAD_SUCCESS_SQL));
  for (const col of PROTECTED_COLUMNS) {
    assert.ok(!cols.has(col), `protected column "${col}" must not be written by the download step`);
  }
});

test('external_ids and licenses are MERGED, not overwritten', () => {
  // `||` concatenation on top of the existing value preserves keys the
  // download step does not know about (e.g. oarx_legacy from migration 029).
  assert.match(APPLY_DOWNLOAD_SUCCESS_SQL, /external_ids = COALESCE\(external_ids, '\{\}'::jsonb\) \|\|/);
  assert.match(APPLY_DOWNLOAD_SUCCESS_SQL, /licenses = COALESCE\(licenses, '\{\}'::jsonb\) \|\|/);
});
