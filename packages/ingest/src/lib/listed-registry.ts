/**
 * Per-document coverage registry (openarx-tvts).
 *
 * Every entry fetched from an arXiv listing (Atom feed) is registered in
 * `documents` with status='listed' — metadata only, no files. This makes
 * `documents` the full per-document map of the source, including papers
 * that were never downloaded: coverage becomes count(ready)/count(*)
 * instead of aggregate counters, and gaps are concrete source_ids.
 *
 * Pure row/SQL builders live here so they can be unit-tested without a DB;
 * RunnerService.registerListedEntries() executes the query.
 */
import { randomUUID } from 'node:crypto';
import { computeOarxId } from '@openarx/api';
import type { ArxivEntry } from '../sources/arxiv-source.js';

/** Delegates to the single-source formula in @openarx/api (openarx-pc98). */
export function computeArxivOarxId(arxivId: string): string {
  return computeOarxId('arxiv', arxivId);
}

/** Flat parameter row for one listed document, in LISTED_INSERT column order. */
export interface ListedRow {
  id: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  authorsJson: string;
  abstract: string;
  categories: string[];
  publishedAt: Date | null;
  externalIdsJson: string;
  oarxId: string;
}

/** Params per row in the VALUES tuple — keep in sync with buildListedInsertSql. */
export const LISTED_ROW_PARAM_COUNT = 10;

/**
 * Map listing entries to insert rows. Deduplicates by arxivId within the
 * batch (defensive — the feed should not repeat ids within one window).
 */
export function buildListedRows(entries: ArxivEntry[]): ListedRow[] {
  const byId = new Map<string, ListedRow>();
  for (const e of entries) {
    if (byId.has(e.arxivId)) continue;
    const id = randomUUID();
    const oarxId = computeArxivOarxId(e.arxivId);
    const publishedAt = new Date(e.publishedAt);
    byId.set(e.arxivId, {
      id,
      sourceId: e.arxivId,
      sourceUrl: `https://arxiv.org/abs/${e.arxivId}`,
      title: e.title,
      authorsJson: JSON.stringify(e.authors),
      abstract: e.abstract,
      categories: e.categories ?? [],
      publishedAt: isNaN(publishedAt.getTime()) ? null : publishedAt,
      externalIdsJson: JSON.stringify({
        oarx: oarxId,
        arxiv: e.arxivId,
        ...(e.doi ? { doi: e.doi } : {}),
        ...(e.journalRef ? { journal_ref: e.journalRef } : {}),
      }),
      oarxId,
    });
  }
  return [...byId.values()];
}

/** Flatten rows into the positional parameter array for buildListedInsertSql. */
export function flattenListedRows(rows: ListedRow[]): unknown[] {
  return rows.flatMap((r) => [
    r.id, r.sourceId, r.sourceUrl, r.title, r.authorsJson,
    r.abstract, r.categories, r.publishedAt, r.externalIdsJson, r.oarxId,
  ]);
}

/**
 * Multi-row INSERT for listed registry rows.
 *
 * Idempotency is two-layered:
 * - NOT EXISTS over (source, source_id) ANY version — never touch a paper
 *   already known in any status (incl. soft-deleted: the row still exists,
 *   so a deleted paper is not resurrected by re-listing).
 * - ON CONFLICT (source, source_id, version) DO NOTHING — belt-and-braces
 *   for concurrent inserts racing past the NOT EXISTS snapshot.
 *
 * oarx_id collision guard: with 16-hex ids (migration 029, openarx-pc98)
 * collisions are negligible (64 bits), but the unique idx_documents_oarx_id
 * is NOT the ON CONFLICT target, so a single colliding row would still
 * abort the whole multi-row INSERT — the guard stays as belt-and-braces.
 * (History: at 8 hex = 32 bits, 33 real pairs were hit during the 2025
 * registry backfill, e.g. 2502.15708 vs 2101.11711 → oarx-f629d9b6.)
 *
 * indexing_tier is explicitly NULL (column default is 'full'): the pipeline
 * gate decides the tier at processing time, after license is known.
 */
export function buildListedInsertSql(rowCount: number): string {
  const tuples: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const b = r * LISTED_ROW_PARAM_COUNT;
    tuples.push(
      `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, ` +
      `$${b + 6}, $${b + 7}::text[], $${b + 8}::timestamptz, $${b + 9}::jsonb, $${b + 10})`,
    );
  }
  return `INSERT INTO documents (
      id, version, source, source_id, source_url,
      title, authors, abstract, categories, published_at,
      status, processing_log, processing_cost, provenance,
      external_ids, oarx_id, retry_count, concept_id, licenses, indexing_tier
    )
    SELECT v.id, 1, 'arxiv', v.source_id, v.source_url,
           v.title, v.authors, v.abstract, v.categories, v.published_at,
           'listed', '[]'::jsonb, 0, '[]'::jsonb,
           v.external_ids, v.oarx_id, 0, v.id, '{}'::jsonb, NULL
    FROM (VALUES ${tuples.join(', ')}) AS v(
      id, source_id, source_url, title, authors,
      abstract, categories, published_at, external_ids, oarx_id
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.source = 'arxiv' AND d.source_id = v.source_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM documents d2 WHERE d2.oarx_id = v.oarx_id
    )
    ON CONFLICT (source, source_id, version) DO NOTHING`;
}
