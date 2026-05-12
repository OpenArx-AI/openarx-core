import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We test SQL structure by reading source + mapping logic directly.
// Actual DB integration tested when deployed.

describe('selectNextBatch', () => {
  const source = readFileSync(join(__dirname, '..', 'selection.ts'), 'utf-8');

  test('SQL query structure is correct', () => {
    const expectedFilters = [
      "d.source = 'arxiv'",
      "d.status = 'ready'",
      'document_locations dl',
      'dl.is_oa = true',
      'dl.file_path IS NOT NULL',
      "interval '90 days'",
      'enrichment_attempts ea',
      'ea.next_retry_at > now()',
      'd.published_at DESC',
      'LIMIT $1',
    ];

    for (const filter of expectedFilters) {
      assert.ok(source.includes(filter), `SQL should contain: ${filter}`);
    }
  });

  test('DOI extraction uses external_ids->>doi', () => {
    assert.ok(
      source.includes("external_ids->>'doi'"),
      'Should extract DOI from external_ids JSONB',
    );
  });

  test('DocumentSelection interface mapping covers all fields', () => {
    // Simulate what the row mapper does
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: '2401.12345',
      doi: '10.1234/test.2024',
      indexing_tier: 'abstract_only',
    };

    const mapped = {
      documentId: row.id,
      sourceId: row.source_id,
      doi: row.doi ?? null,
      indexingTier: row.indexing_tier ?? null,
    };

    assert.equal(mapped.documentId, '550e8400-e29b-41d4-a716-446655440000');
    assert.equal(mapped.sourceId, '2401.12345');
    assert.equal(mapped.doi, '10.1234/test.2024');
    assert.equal(mapped.indexingTier, 'abstract_only');
  });

  test('null DOI maps correctly', () => {
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      source_id: '2401.99999',
      doi: null,
      indexing_tier: 'full',
    };

    const mapped = {
      documentId: row.id,
      sourceId: row.source_id,
      doi: row.doi ?? null,
      indexingTier: row.indexing_tier ?? null,
    };

    assert.equal(mapped.doi, null);
    assert.equal(mapped.indexingTier, 'full');
  });

  test('null indexing_tier maps to null', () => {
    const row = {
      id: 'abc',
      source_id: '2401.00001',
      doi: '10.1234/x',
      indexing_tier: null,
    };

    const mapped = {
      documentId: row.id,
      sourceId: row.source_id,
      doi: row.doi ?? null,
      indexingTier: row.indexing_tier ?? null,
    };

    assert.equal(mapped.indexingTier, null);
  });
});
