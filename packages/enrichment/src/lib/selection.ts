/**
 * Selection logic — pick next batch of documents for enrichment.
 *
 * Filters:
 * - source = arxiv, status = ready
 * - Skip docs with valid OA file + open license (D8: 90-day cooldown)
 * - Skip recently enriched docs (D4: global cooldown via enrichment_attempts)
 * - Order by published_at DESC (newer first)
 *
 * Design ref: docs/compliance/enrichment_worker_design.md (D2, D4, D8)
 */

import { query } from '@openarx/api';

export interface DocumentSelection {
  documentId: string;
  sourceId: string;
  doi: string | null;
  indexingTier: string | null;
}

/**
 * Select next batch of documents eligible for enrichment.
 *
 * Returns mix of abstract_only and full docs (D8: mix priority).
 * Documents without published DOI are included — caller decides to skip or record 'no_doi'.
 */
export async function selectNextBatch(
  batchSize: number,
): Promise<DocumentSelection[]> {
  const result = await query<{
    id: string;
    source_id: string;
    doi: string | null;
    indexing_tier: string | null;
  }>(
    `SELECT
       d.id,
       d.source_id,
       d.external_ids->>'doi' AS doi,
       d.indexing_tier
     FROM documents d
     WHERE d.source = 'arxiv'
       AND d.status = 'ready'
       -- D8: skip docs already having valid OA file with open license (90-day cooldown)
       AND NOT EXISTS (
         SELECT 1 FROM document_locations dl
          WHERE dl.document_id = d.id
            AND dl.is_oa = true
            AND dl.file_path IS NOT NULL
            AND dl.created_at > now() - interval '90 days'
       )
       -- D4: skip recently enriched (global cooldown)
       AND NOT EXISTS (
         SELECT 1 FROM enrichment_attempts ea
          WHERE ea.document_id = d.id
            AND ea.next_retry_at > now()
       )
     ORDER BY d.published_at DESC
     LIMIT $1`,
    [batchSize],
  );

  return result.rows.map(row => ({
    documentId: row.id,
    sourceId: row.source_id,
    doi: row.doi ?? null,
    indexingTier: row.indexing_tier ?? null,
  }));
}
