import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  BatchSearchQuery,
  Chunk,
  ChunkContext,
  QdrantFilter,
  SearchResult,
  VectorStore,
} from '@openarx/types';

const COLLECTION = 'chunks';

export interface MergedFilter {
  must: Array<Record<string, unknown>>;
  must_not?: Array<Record<string, unknown>>;
}

/** Add the F3 versioning invariant (`is_latest=true`) to a caller-supplied
 *  filter, preserving any must / must_not they passed.
 *
 *  Soft-delete (`deleted != true`) used to be added here as a Qdrant-layer
 *  defence-in-depth guard. Removed 2026-05-09 (openarx-g5t6 latency
 *  investigation): the `deleted` payload index is `keyword`-typed but
 *  inserts use bool values → 0 points indexed → must_not forces a full
 *  scan of 11.6M points, +5.5s/query. Soft-delete is enforced upstream:
 *
 *    - search.ts / find_*.ts: fetchDocuments() drops deletedAt rows
 *    - internal-routes.ts: explicit `if (doc && !doc.deletedAt)` filter
 *    - get_document / get_chunks: explicit deletedAt check
 *
 *  Restoring this guard requires recreating the index as bool + back-
 *  filling `deleted: false` on existing points. Deferred to a later
 *  follow-up; tracked in the openarx-g5t6 follow-up issue.
 *
 *  Exported for unit tests; production callers go via VectorStore methods. */
export function mergeLatestGuard(filter: QdrantFilter | undefined): MergedFilter {
  const must: Array<Record<string, unknown>> = [
    ...((filter?.must as Array<Record<string, unknown>>) ?? []),
    { key: 'is_latest', match: { value: true } },
  ];
  const must_not: Array<Record<string, unknown>> = [
    ...((filter?.must_not as Array<Record<string, unknown>>) ?? []),
  ];
  return { must, must_not };
}

export interface QdrantVectorStoreConfig {
  url?: string;
}

export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient;

  constructor(config?: QdrantVectorStoreConfig) {
    this.client = new QdrantClient({
      url: config?.url ?? process.env.QDRANT_URL ?? 'http://localhost:6333',
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });
  }

  /** Create payload index on `deleted` field so the must_not filter in
   *  search paths is cheap (low-cardinality boolean). Idempotent — Qdrant
   *  returns 200 if the index already exists. Call once at service
   *  startup; safe to re-run.
   *
   *  Keyword schema is used (Qdrant ≥1.4 also supports boolean, but
   *  keyword works on all versions and payload value is still {true,false}). */
  async initDeletedPayloadIndex(): Promise<void> {
    try {
      await this.client.createPayloadIndex(COLLECTION, {
        field_name: 'deleted',
        field_schema: 'keyword',
        wait: true,
      });
    } catch (err) {
      // Qdrant returns an error if the index already exists — swallow it.
      // Any other failure we log; startup continues (search filter still
      // works, just without the payload index cost optimisation).
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|duplicate/i.test(msg)) {
        console.error(`[qdrant] initDeletedPayloadIndex failed (non-fatal): ${msg}`);
      }
    }
  }

  /** Flip `deleted` payload on all points belonging to documentId.
   *  Used by admin soft-delete / restore (§7.1/§7.2). Returns number of
   *  points updated. Batches via set_payload with filter — single call
   *  per docId regardless of chunk count. */
  async setDocumentDeleted(documentId: string, deleted: boolean): Promise<number> {
    // Count first so the caller can verify (and 0 means either no chunks
    // yet or document_id mismatch — both visible to operator).
    const { count } = await this.client.count(COLLECTION, {
      filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      exact: true,
    });
    if (count === 0) return 0;

    await this.client.setPayload(COLLECTION, {
      payload: { deleted },
      filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
      wait: true,
    });
    return count;
  }

  async upsertChunks(chunks: Chunk[], documentMeta?: { conceptId?: string; version?: number }): Promise<void> {
    if (chunks.length === 0) return;

    const points = chunks.map((chunk) => ({
      id: chunk.qdrantPointId ?? chunk.id,
      vector: chunk.vectors,
      payload: {
        chunk_id: chunk.id,
        document_id: chunk.documentId,
        document_title: chunk.context.documentTitle,
        section_title: chunk.context.sectionName ?? '',
        section_path: chunk.context.sectionPath ?? '',
        position_in_document: chunk.context.positionInDocument,
        total_chunks: chunk.context.totalChunks,
        content: chunk.content,
        // LLM-derived markers (search v2 — openarx-g8af).
        // Filterable on Qdrant side: content_type (enum), entities (string[]),
        // self_contained (bool). summary + key_concept are duplicated for
        // diversification post-fetch and to avoid PG round-trip on display.
        ...(chunk.context.summary ? { summary: chunk.context.summary } : {}),
        ...(chunk.context.keyConcept ? { key_concept: chunk.context.keyConcept } : {}),
        ...(chunk.context.contentType ? { content_type: chunk.context.contentType } : {}),
        ...(chunk.context.entities && chunk.context.entities.length > 0
          ? { entities: chunk.context.entities }
          : {}),
        ...(typeof chunk.context.selfContained === 'boolean'
          ? { self_contained: chunk.context.selfContained }
          : {}),
        // F3 versioning fields
        is_latest: true,
        ...(documentMeta?.conceptId ? { concept_id: documentMeta.conceptId } : {}),
        ...(documentMeta?.version ? { version: documentMeta.version } : {}),
        // Soft-delete payload flag (core_soft_delete_spec §5.1).
        // New points default to deleted=false. Search filters apply
        // must_not {deleted:true}. Admin delete toggles via set_payload.
        deleted: false,
      },
    }));

    // Batch upsert (100 points per call) with retry
    const BATCH_SIZE = 100;
    const MAX_RETRIES = 3;

    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await this.client.upsert(COLLECTION, { points: batch });
          break;
        } catch (err) {
          if (attempt < MAX_RETRIES - 1) {
            const delay = 1000 * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw new Error(
              `Qdrant upsert failed after ${MAX_RETRIES} attempts (batch ${Math.floor(i / BATCH_SIZE) + 1}, ${batch.length} points): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // Verify: count check for the document
    const documentId = chunks[0].documentId;
    try {
      const countResult = await this.client.count(COLLECTION, {
        filter: { must: [{ key: 'document_id', match: { value: documentId } }] },
        exact: true,
      });
      if (countResult.count < chunks.length) {
        throw new Error(
          `Qdrant verify failed: expected >=${chunks.length} points for document ${documentId}, got ${countResult.count}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Qdrant verify')) throw err;
      // Count check itself failed — log but don't block
      console.error(`[qdrant] Verify count check failed for ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async search(
    queryVector: number[],
    vectorName: string,
    limit: number,
    filters?: Record<string, unknown>,
    maxPerDocument?: number,
  ): Promise<SearchResult[]> {
    // Always filter to latest version chunks (F3 versioning). Soft-delete
    // guard removed at Qdrant layer (see mergeLatestGuard comment for why);
    // PG-layer filters in MCP search handlers + internal-routes drop
    // deletedAt rows after fetchDocuments — keeping the invariant.
    const baseFilter = this.buildFilter(filters ?? {});
    baseFilter.must.push({ key: 'is_latest', match: { value: true } });
    const filter: { must: Array<Record<string, unknown>>; must_not: Array<Record<string, unknown>> } = {
      must: baseFilter.must,
      must_not: [],
    };

    // Overfetch when diversifying to ensure enough results after per-doc cap
    const fetchLimit = maxPerDocument ? limit * 4 : limit;

    const results = await this.client.query(COLLECTION, {
      query: queryVector,
      using: vectorName,
      limit: fetchLimit,
      filter,
      with_payload: true,
    });

    const mapped = results.points.map((point) => {
      const payload = point.payload as Record<string, unknown>;
      return {
        chunkId: payload.chunk_id as string,
        documentId: payload.document_id as string,
        content: payload.content as string,
        context: {
          documentTitle: payload.document_title as string,
          sectionName: (payload.section_title as string) || undefined,
          sectionPath: (payload.section_path as string) || undefined,
          positionInDocument: payload.position_in_document as number,
          totalChunks: payload.total_chunks as number,
          // LLM-derived markers (search v2). May be undefined for chunks
          // created before openarx-g8af payload extension; backfilled via
          // scripts/backfill-qdrant-payload.mjs from PG chunks.context.
          summary: (payload.summary as string) || undefined,
          keyConcept: (payload.key_concept as string) || undefined,
          contentType: (payload.content_type as string) || undefined,
          entities: Array.isArray(payload.entities) ? (payload.entities as string[]) : undefined,
          selfContained: typeof payload.self_contained === 'boolean'
            ? (payload.self_contained as boolean)
            : undefined,
        } as ChunkContext,
        score: point.score ?? 0,
      };
    });

    if (!maxPerDocument) return mapped;

    // Diversify: cap results per document, preserve score ordering
    const docCounts = new Map<string, number>();
    const diversified: SearchResult[] = [];
    for (const r of mapped) {
      const count = docCounts.get(r.documentId) ?? 0;
      if (count < maxPerDocument) {
        diversified.push(r);
        docCounts.set(r.documentId, count + 1);
        if (diversified.length >= limit) break;
      }
    }
    return diversified;
  }

  async batchSearch(queries: BatchSearchQuery[]): Promise<SearchResult[][]> {
    if (queries.length === 0) return [];

    // Build each search entry with the same F3 is_latest guard we apply in
    // single-search, plus whatever must/must_not the caller specified. A
    // single POST /collections/chunks/points/query/batch handles all of them.
    const searches = queries.map((q) => ({
      query: q.vector,
      using: q.vectorName,
      limit: q.limit,
      filter: mergeLatestGuard(q.filter),
      with_payload: true,
    }));

    const responses = await this.client.queryBatch(COLLECTION, { searches });

    return responses.map((resp) =>
      (resp.points ?? []).map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        return {
          chunkId: payload.chunk_id as string,
          documentId: payload.document_id as string,
          content: payload.content as string,
          context: {
            documentTitle: payload.document_title as string,
            sectionName: (payload.section_title as string) || undefined,
            sectionPath: (payload.section_path as string) || undefined,
            positionInDocument: payload.position_in_document as number,
            totalChunks: payload.total_chunks as number,
            summary: (payload.summary as string) || undefined,
            keyConcept: (payload.key_concept as string) || undefined,
            contentType: (payload.content_type as string) || undefined,
            entities: Array.isArray(payload.entities) ? (payload.entities as string[]) : undefined,
            selfContained: typeof payload.self_contained === 'boolean'
              ? (payload.self_contained as boolean)
              : undefined,
          } as ChunkContext,
          score: point.score ?? 0,
        };
      }),
    );
  }

  async getByDocumentId(documentId: string): Promise<Chunk[]> {
    const results = await this.client.scroll(COLLECTION, {
      filter: {
        must: [{ key: 'document_id', match: { value: documentId } }],
      },
      with_payload: true,
      with_vector: true,
      limit: 10000,
    });

    return results.points.map((point) => {
      const payload = point.payload as Record<string, unknown>;
      const vectors = point.vector as Record<string, number[]>;
      return {
        id: payload.chunk_id as string,
        version: 1,
        createdAt: new Date(),
        documentId: payload.document_id as string,
        content: payload.content as string,
        context: {
          documentTitle: payload.document_title as string,
          sectionName: (payload.section_title as string) || undefined,
          sectionPath: (payload.section_path as string) || undefined,
          positionInDocument: payload.position_in_document as number,
          totalChunks: payload.total_chunks as number,
          // LLM-derived markers (search v2). May be undefined for chunks
          // created before openarx-g8af payload extension; backfilled via
          // scripts/backfill-qdrant-payload.mjs from PG chunks.context.
          summary: (payload.summary as string) || undefined,
          keyConcept: (payload.key_concept as string) || undefined,
          contentType: (payload.content_type as string) || undefined,
          entities: Array.isArray(payload.entities) ? (payload.entities as string[]) : undefined,
          selfContained: typeof payload.self_contained === 'boolean'
            ? (payload.self_contained as boolean)
            : undefined,
        } as ChunkContext,
        vectors: vectors ?? {},
        metrics: {},
        qdrantPointId: String(point.id),
      };
    });
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    try {
      await this.client.delete(COLLECTION, {
        filter: {
          must: [{ key: 'document_id', match: { value: documentId } }],
        },
      });
    } catch {
      // Non-fatal
    }
  }

  private buildFilter(
    filters: Record<string, unknown>,
  ): { must: Array<Record<string, unknown>> } {
    const must: Array<Record<string, unknown>> = [];

    for (const [key, value] of Object.entries(filters)) {
      if (typeof value === 'string') {
        must.push({ key, match: { value } });
      } else if (Array.isArray(value)) {
        // Match any of the values
        for (const v of value) {
          must.push({ key, match: { value: v } });
        }
      }
    }

    return { must };
  }

}
