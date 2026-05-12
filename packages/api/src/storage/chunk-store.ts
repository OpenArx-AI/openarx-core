/**
 * PgChunkStore — lifecycle-aware CRUD for the chunks table (openarx-q2eh).
 *
 * Chunks are persisted in PG as soon as the chunker produces them, with
 * `status = 'pending_embed'`. Embedders and indexer then transition status.
 * On pipeline failure mid-stream, chunks remain in PG and the next retry
 * resumes from the embed step, avoiding repeated LLM chunking cost.
 */

import type { Chunk, Document } from '@openarx/types';
import { query } from '../db/pool.js';

type ChunkStatus = 'pending_embed' | 'embedded' | 'indexed' | 'indexed_partial';

export interface ChunkStatusCounts {
  pending_embed: number;
  embedded: number;
  indexed: number;
  indexed_partial: number;
}

interface ChunkRow {
  id: string;
  version: number;
  created_at: Date;
  document_id: string;
  content: string;
  context: unknown;
  metrics: unknown;
  qdrant_point_id: string | null;
  position: number | null;
  section_title: string | null;
  section_path: string | null;
  status: ChunkStatus;
  embedded_at: Date | null;
  indexed_at: Date | null;
}

export class PgChunkStore {
  /**
   * Insert chunks with status='pending_embed'. Idempotent via ON CONFLICT (id).
   * Caller must have assigned chunk.id and chunk.qdrantPointId before calling.
   */
  async insertPendingChunks(chunks: Chunk[], document: Document): Promise<void> {
    if (chunks.length === 0) return;

    const BATCH_SIZE = 50;
    const authorsText = document.authors.map((a) => a.name).join(', ');

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const offset = j * 13;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13})`,
        );
        values.push(
          chunk.id,
          chunk.documentId,
          chunk.content,
          JSON.stringify(chunk.context),
          JSON.stringify(chunk.metrics),
          chunk.qdrantPointId ?? null,
          chunk.context.positionInDocument,
          chunk.context.sectionName ?? null,
          chunk.context.sectionPath ?? null,
          document.title,
          document.sourceId,
          authorsText,
          'pending_embed',
        );
      }

      await query(
        `INSERT INTO chunks (id, document_id, content, context, metrics, qdrant_point_id,
                             position, section_title, section_path,
                             document_title, document_source_id, document_authors_text, status)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (id) DO NOTHING`,
        values,
      );
    }
  }

  /**
   * Load chunks from PG for resume — only those still needing work.
   * Returns chunks with `status IN ('pending_embed','embedded','indexed_partial')`
   * ordered by position. Vectors are NOT loaded (they live in Qdrant); resume
   * path re-runs the embedders, which overwrite Qdrant named vectors.
   */
  async loadChunksForResume(documentId: string): Promise<Chunk[]> {
    const result = await query<ChunkRow>(
      `SELECT id, version, created_at, document_id, content, context, metrics,
              qdrant_point_id, position, section_title, section_path,
              status, embedded_at, indexed_at
         FROM chunks
        WHERE document_id = $1
          AND status IN ('pending_embed','embedded','indexed_partial')
        ORDER BY position NULLS LAST, created_at`,
      [documentId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      version: row.version,
      createdAt: row.created_at,
      documentId: row.document_id,
      content: row.content,
      context: row.context as Chunk['context'],
      metrics: (row.metrics as Chunk['metrics']) ?? {},
      vectors: {},
      qdrantPointId: row.qdrant_point_id ?? undefined,
      status: row.status,
      embeddedAt: row.embedded_at ?? undefined,
      indexedAt: row.indexed_at ?? undefined,
    }));
  }

  /**
   * Count chunks by status for a single doc. Used by orchestrator to decide
   * virgin / resume / rerun.
   */
  async countByStatus(documentId: string): Promise<ChunkStatusCounts> {
    const result = await query<{ status: ChunkStatus; cnt: string }>(
      `SELECT status, COUNT(*)::text AS cnt
         FROM chunks
        WHERE document_id = $1
        GROUP BY status`,
      [documentId],
    );

    const counts: ChunkStatusCounts = {
      pending_embed: 0, embedded: 0, indexed: 0, indexed_partial: 0,
    };
    for (const row of result.rows) {
      counts[row.status] = Number(row.cnt);
    }
    return counts;
  }

  /** Transition chunks to `status='embedded'` after embedders succeed. */
  async markEmbedded(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await query(
      `UPDATE chunks
          SET status = 'embedded', embedded_at = now()
        WHERE id = ANY($1::uuid[])
          AND status = 'pending_embed'`,
      [chunkIds],
    );
  }

  /** Transition chunks to `indexed` (or `indexed_partial`) after Qdrant upsert. */
  async markIndexed(chunkIds: string[], partial: boolean): Promise<void> {
    if (chunkIds.length === 0) return;
    const target: ChunkStatus = partial ? 'indexed_partial' : 'indexed';
    await query(
      `UPDATE chunks
          SET status = $2, indexed_at = now()
        WHERE id = ANY($1::uuid[])`,
      [chunkIds, target],
    );
  }

  /** Hard-delete all chunks for a document. Used on rerun + abort cleanup. */
  async deleteByDocumentId(documentId: string): Promise<number> {
    const result = await query(
      `DELETE FROM chunks WHERE document_id = $1`,
      [documentId],
    );
    return result.rowCount ?? 0;
  }

  /** Cleanup for ChunkingAbortedError — remove only not-yet-indexed rows. */
  async deletePendingByDocumentId(documentId: string): Promise<number> {
    const result = await query(
      `DELETE FROM chunks
        WHERE document_id = $1
          AND status IN ('pending_embed','embedded')`,
      [documentId],
    );
    return result.rowCount ?? 0;
  }

  /** Orphan GC: delete chunks stuck in pending/embedded state past TTL. */
  async deleteOrphans(olderThanDays: number, limit: number): Promise<number> {
    const result = await query(
      `WITH victims AS (
         SELECT id FROM chunks
          WHERE status IN ('pending_embed','embedded')
            AND created_at < now() - ($1::text || ' days')::interval
          LIMIT $2
       )
       DELETE FROM chunks WHERE id IN (SELECT id FROM victims)`,
      [String(olderThanDays), limit],
    );
    return result.rowCount ?? 0;
  }
}
