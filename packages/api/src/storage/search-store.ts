import type { ChunkContext } from '@openarx/types';
import { query } from '../db/pool.js';

export interface BM25Result {
  chunkId: string;
  documentId: string;
  content: string;
  context: ChunkContext;
  bm25Score: number;
}

interface BM25Row {
  id: string;
  document_id: string;
  content: string;
  context: unknown;
  rank: number;
  max_rank: number;
}

export class SearchStore {
  async searchBM25(queryText: string, limit: number): Promise<BM25Result[]> {
    const result = await query<BM25Row>(
      `WITH ranked AS (
        SELECT
          id,
          document_id,
          content,
          context,
          ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
        FROM chunks
        WHERE search_vector @@ plainto_tsquery('english', $1)
          AND is_latest = TRUE
          AND status IN ('indexed', 'indexed_partial')
          AND section_title NOT ILIKE '%reference%'
          AND section_title NOT ILIKE '%bibliograph%'
        ORDER BY rank DESC
        LIMIT $2
      )
      SELECT *, max(rank) OVER () AS max_rank FROM ranked`,
      [queryText, limit],
    );

    return result.rows.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      content: row.content,
      context: row.context as ChunkContext,
      bm25Score: row.max_rank > 0 ? row.rank / row.max_rank : 0,
    }));
  }
}
