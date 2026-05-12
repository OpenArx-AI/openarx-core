/**
 * Dev search — Cross-encoder reranker experiment.
 *
 * Pipeline: retrieve top-N with linear fusion → rerank with bge-reranker-v2-m3 → return top-K.
 *
 * The reranker is a cross-encoder that scores (query, passage) pairs with full
 * cross-attention, giving much higher quality relevance judgments than bi-encoder
 * similarity or BM25. The trade-off is latency (~100ms for 30 passages).
 *
 * Papers:
 * - RAG Survey (2312.10997): recommends bge-reranker-large for second-stage
 * - "When Documents Disagree" (2603.21460): cross-encoder reranking + RRF
 * - "Adversarial Hubness Detector" (2602.22427): second-stage reranking in production
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearchResult, SearchResult } from '@openarx/types';
import type { BM25Result } from '@openarx/api';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, truncateChunk, jsonResult } from '../shared/helpers.js';

const VECTOR_WEIGHT = Number(process.env.VECTOR_WEIGHT ?? 0.6);
const BM25_WEIGHT = Number(process.env.BM25_WEIGHT ?? 0.4);

/** Env-driven default vector model (same as v1). openarx-qf3f/qraw. */
const DEFAULT_VECTOR_MODEL =
  (process.env.MCP_SEARCH_DEFAULT_VECTOR_MODEL ?? 'gemini') as 'gemini' | 'specter2';

/** How many candidates to retrieve before reranking.
 * 15 is a good balance: covers enough candidates for quality,
 * keeps reranker latency under 10s on CPU with ONNX. */
const RERANK_CANDIDATE_COUNT = 15;

function mergeHybridResults(
  vectorResults: SearchResult[],
  bm25Results: BM25Result[],
): HybridSearchResult[] {
  const merged = new Map<string, HybridSearchResult>();

  for (const r of vectorResults) {
    merged.set(r.chunkId, {
      chunkId: r.chunkId,
      documentId: r.documentId,
      content: r.content,
      context: r.context,
      vectorScore: r.score,
      bm25Score: 0,
      finalScore: 0,
    });
  }

  for (const r of bm25Results) {
    const existing = merged.get(r.chunkId);
    if (existing) {
      existing.bm25Score = r.bm25Score;
    } else {
      merged.set(r.chunkId, {
        chunkId: r.chunkId,
        documentId: r.documentId,
        content: r.content,
        context: r.context,
        vectorScore: 0,
        bm25Score: r.bm25Score,
        finalScore: 0,
      });
    }
  }

  for (const r of merged.values()) {
    r.finalScore = VECTOR_WEIGHT * r.vectorScore + BM25_WEIGHT * r.bm25Score;
  }

  return [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
}

function diversifyHybridResults(
  results: HybridSearchResult[],
  maxPerDocument: number,
): HybridSearchResult[] {
  const docCounts = new Map<string, number>();
  const diversified: HybridSearchResult[] = [];
  for (const r of results) {
    const count = docCounts.get(r.documentId) ?? 0;
    if (count < maxPerDocument) {
      diversified.push(r);
      docCounts.set(r.documentId, count + 1);
    }
  }
  return diversified;
}

export function registerSearch(server: McpServer, ctx: AppContext): void {
  server.tool(
    'search',
    'Hybrid semantic + keyword search across scientific papers. Combines vector similarity with BM25 full-text matching for best results on both conceptual queries and exact terms (arXiv IDs, author names).',
    {
      query: z.string().describe('Search query text'),
      vectorModel: z
        .enum(['gemini', 'specter2'])
        .default(DEFAULT_VECTOR_MODEL)
        .describe('Embedding model to use'),
      categories: z
        .array(z.string())
        .optional()
        .describe('Filter by arXiv categories (e.g. cs.AI, cs.LG)'),
      dateFrom: z
        .string()
        .optional()
        .describe('Filter: published on or after (ISO date)'),
      dateTo: z
        .string()
        .optional()
        .describe('Filter: published on or before (ISO date)'),
      maxPerDocument: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(2)
        .describe('Max chunks per document (diversification)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Max results to return'),
    },
    async ({ query, vectorModel, categories, dateFrom, dateTo, maxPerDocument, limit }) => {
      const { vector, vectorName } = await embedQuery(query, vectorModel, ctx);

      // Stage 1: Retrieve large candidate set with linear fusion
      const candidateCount = Math.max(RERANK_CANDIDATE_COUNT, limit * 3);
      const [vectorRaw, bm25Raw] = await Promise.all([
        ctx.vectorStore.search(vector, vectorName, candidateCount, undefined, maxPerDocument),
        ctx.searchStore.searchBM25(query, candidateCount),
      ]);

      const hybrid = mergeHybridResults(vectorRaw, bm25Raw);
      // Take top candidates before reranking (no diversification yet — reranker should see all)
      const candidates = hybrid.slice(0, RERANK_CANDIDATE_COUNT);

      // Stage 2: Rerank with cross-encoder
      let reranked = candidates;
      try {
        const passages = candidates.map((c) => c.content);
        const rerankResult = await ctx.rerankerClient.rerank(query, passages);

        // Apply reranker scores as finalScore, preserving original scores for display
        reranked = rerankResult.scores.map((s) => {
          const original = candidates[s.index];
          return {
            ...original,
            finalScore: s.score,
          };
        });
      } catch (err) {
        // Graceful degradation: if reranker is down, fall back to linear fusion order
        console.error('[dev/search] Reranker unavailable, falling back to linear fusion:', err instanceof Error ? err.message : err);
      }

      // Stage 3: Diversify and filter
      const deduped = diversifyHybridResults(reranked, maxPerDocument);

      const docIds = deduped.map((r) => r.documentId);
      const docs = await fetchDocuments(docIds, ctx);

      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const categorySet = categories ? new Set(categories) : undefined;

      const results = deduped
        .map((r) => {
          const doc = docs.get(r.documentId);
          if (!doc) return null;

          if (categorySet && !doc.categories.some((c) => categorySet.has(c))) {
            return null;
          }
          const pubMs = doc.publishedAt.getTime();
          if (dateFromMs && pubMs < dateFromMs) return null;
          if (dateToMs && pubMs > dateToMs) return null;

          return {
            chunkContent: truncateChunk(r.content),
            chunkContext: r.context,
            documentId: r.documentId,
            documentTitle: doc.title,
            authors: doc.authors,
            sourceUrl: doc.sourceUrl,
            vectorScore: r.vectorScore,
            bm25Score: r.bm25Score,
            finalScore: r.finalScore,
          };
        })
        .filter(Boolean)
        .slice(0, limit);

      return jsonResult({ results });
    },
  );
}
