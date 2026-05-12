/**
 * IndexerStep — writes chunks to PostgreSQL + Qdrant.
 *
 * When PERSIST_CHUNKS_BEFORE_EMBED is on (openarx-q2eh), PG rows already exist
 * (inserted by chunkWorker) — this step just upserts to Qdrant and transitions
 * chunk status to 'indexed' (or 'indexed_partial' for chunks missing SPECTER2).
 *
 * When OFF (legacy), this step still performs the full DELETE + INSERT + Qdrant
 * upsert pattern used before the feature flag was introduced.
 */

import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { query, PgChunkStore } from '@openarx/api';
import type {
  Chunk,
  Document,
  ParsedDocument,
  PipelineContext,
  PipelineStep,
  VectorStore,
} from '@openarx/types';
import { buildStructuredContent } from '../lib/structured-content.js';

const PERSIST_CHUNKS_BEFORE_EMBED =
  (process.env.PERSIST_CHUNKS_BEFORE_EMBED ?? 'false').toLowerCase() === 'true';

export interface IndexerStepInput {
  document: Document;
  chunks: Chunk[];
  parsedDocument: ParsedDocument;
}

export interface IndexerStepConfig {
  vectorStore: VectorStore;
  qdrantUrl?: string;
}

export class IndexerStep implements PipelineStep<IndexerStepInput, void> {
  readonly name = 'indexer';
  private readonly vectorStore: VectorStore;
  private readonly qdrantClient: QdrantClient;
  private readonly chunkStore = new PgChunkStore();

  constructor(config: IndexerStepConfig) {
    this.vectorStore = config.vectorStore;
    this.qdrantClient = new QdrantClient({
      url: config.qdrantUrl ?? process.env.QDRANT_URL ?? 'http://localhost:6333',
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });
  }

  async process(input: IndexerStepInput, context: PipelineContext): Promise<void> {
    const { document, chunks, parsedDocument } = input;
    const { logger } = context;

    if (chunks.length === 0) {
      logger.warn('No chunks to index');
      return;
    }

    if (PERSIST_CHUNKS_BEFORE_EMBED) {
      // New path: PG rows already exist (pending_embed/embedded). Ensure every
      // chunk has a qdrantPointId (chunker assigns it, but resumed chunks
      // loaded from PG may have it loaded from DB).
      for (const chunk of chunks) {
        if (!chunk.qdrantPointId) chunk.qdrantPointId = randomUUID();
      }

      logger.info(`Upserting ${chunks.length} chunks to Qdrant`);
      await this.vectorStore.upsertChunks(chunks, {
        conceptId: document.conceptId ?? document.id,
        version: document.version,
      });

      // Transition PG rows to indexed / indexed_partial.
      const partial = chunks.some((c) => !c.vectors.specter2);
      await this.chunkStore.markIndexed(chunks.map((c) => c.id), partial);
    } else {
      // Legacy path: DELETE + INSERT chunks, then Qdrant upsert.
      for (const chunk of chunks) {
        chunk.qdrantPointId = randomUUID();
      }

      logger.info(`Deleting existing chunks for document ${document.id}`);
      await this.deleteExistingChunks(document.id, logger);

      logger.info(`Inserting ${chunks.length} chunks into PostgreSQL`);
      await this.insertChunksPg(chunks, document);

      logger.info(`Upserting ${chunks.length} chunks to Qdrant`);
      await this.vectorStore.upsertChunks(chunks, {
        conceptId: document.conceptId ?? document.id,
        version: document.version,
      });
    }

    // F3 versioning: mark old version's chunks as not-latest
    if (document.version > 1 && document.conceptId) {
      await this.deactivateOldVersionChunks(document.conceptId, document.version, document.id, logger);
    }

    // Update document-level fields. structured_content is written here only if
    // the chunker didn't already set it (legacy path, abstract_only without
    // persistence, or first-ever write). The WHERE IS NULL guard makes this
    // idempotent with the chunker-side write.
    await query(
      `UPDATE documents
       SET structured_content = COALESCE(structured_content, $1::jsonb),
           code_links = $2,
           dataset_links = $3,
           benchmark_results = $4,
           extracted_metadata = $5,
           indexing_tier = $6,
           processing_cost = (SELECT COALESCE(SUM(cost), 0) FROM processing_costs WHERE document_id = $7)
       WHERE id = $7`,
      [
        JSON.stringify(buildStructuredContent(parsedDocument)),
        JSON.stringify(document.codeLinks ?? []),
        JSON.stringify(document.datasetLinks ?? []),
        JSON.stringify(document.benchmarkResults ?? []),
        JSON.stringify(document.extractedMetadata ?? {}),
        document.indexingTier ?? 'full',
        document.id,
      ],
    );

    logger.info(`Indexing complete: ${chunks.length} chunks for document ${document.id}`);
  }

  /**
   * Drop both PG chunks and Qdrant points for this document. Used by legacy
   * indexer flow and by document-orchestrator's 'rerun' branch when flipping
   * a previously-indexed doc back through the pipeline.
   */
  async deleteExistingChunks(
    documentId: string,
    logger: PipelineContext['logger'],
  ): Promise<void> {
    // Delete from PostgreSQL
    await query('DELETE FROM chunks WHERE document_id = $1', [documentId]);

    // Delete from Qdrant via filter
    try {
      await this.qdrantClient.delete('chunks', {
        filter: {
          must: [{ key: 'document_id', match: { value: documentId } }],
        },
      });
    } catch (err) {
      logger.warn(`Qdrant delete failed for ${documentId} — orphan points may remain: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async insertChunksPg(chunks: Chunk[], document: Document): Promise<void> {
    const BATCH_SIZE = 50;
    const authorsText = document.authors.map((a) => a.name).join(', ');

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const offset = j * 12;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`,
        );
        values.push(
          chunk.id,
          chunk.documentId,
          chunk.content,
          JSON.stringify(chunk.context),
          JSON.stringify(chunk.metrics),
          chunk.qdrantPointId,
          chunk.context.positionInDocument,
          chunk.context.sectionName ?? null,
          chunk.context.sectionPath ?? null,
          document.title,
          document.sourceId,
          authorsText,
        );
      }

      await query(
        `INSERT INTO chunks (id, document_id, content, context, metrics, qdrant_point_id, position, section_title, section_path, document_title, document_source_id, document_authors_text)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    }
  }

  /**
   * F3 versioning: when indexing version N+1, mark old version chunks as not-latest.
   * Updates both PostgreSQL (is_latest column) and Qdrant (is_latest payload field).
   */
  private async deactivateOldVersionChunks(
    conceptId: string,
    currentVersion: number,
    currentDocId: string,
    logger: PipelineContext['logger'],
  ): Promise<void> {
    // Find all older version document IDs for this concept
    const { rows: oldDocs } = await query<{ id: string }>(
      'SELECT id FROM documents WHERE concept_id = $1 AND version < $2 AND id != $3',
      [conceptId, currentVersion, currentDocId],
    );

    if (oldDocs.length === 0) return;

    const oldDocIds = oldDocs.map((d) => d.id);
    logger.info(`Deactivating chunks for ${oldDocIds.length} old version(s) of concept ${conceptId}`);

    // PostgreSQL: set is_latest = FALSE on old version chunks
    const pgPlaceholders = oldDocIds.map((_, i) => `$${i + 1}`).join(', ');
    await query(
      `UPDATE chunks SET is_latest = FALSE WHERE document_id IN (${pgPlaceholders}) AND is_latest = TRUE`,
      oldDocIds,
    );

    // Qdrant: set is_latest = false on old version points
    for (const oldDocId of oldDocIds) {
      try {
        await this.qdrantClient.setPayload('chunks', {
          payload: { is_latest: false },
          filter: {
            must: [{ key: 'document_id', match: { value: oldDocId } }],
          },
        });
      } catch (err) {
        logger.warn(`Qdrant set_payload failed for old doc ${oldDocId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.info(`Deactivated old version chunks: ${oldDocIds.length} document(s)`);
  }

}
