import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HybridSearchResult, SearchResult } from '@openarx/types';
import type { BM25Result } from '@openarx/api';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult } from '../shared/helpers.js';
import { timed, recordStage } from '../../lib/usage-tracker.js';
import {
  hydrateChunkContexts,
  applyChunkContextFilters,
  diversifyChunks,
  computeFacets,
  formatSearchResult,
  cacheSearchPool,
  type RankedChunk,
  type DiversifyKey,
  type DetailLevel,
} from '../shared/search-helpers.js';

const VECTOR_WEIGHT = Number(process.env.VECTOR_WEIGHT ?? 0.6);
const BM25_WEIGHT = Number(process.env.BM25_WEIGHT ?? 0.4);

/** Env-driven default vector model. Used during openarx-8og1 migration to
 *  route default search to 'specter2' while the 'gemini' named vector is
 *  in a mixed-model state. Revert: unset the env var (openarx-qraw). */
const DEFAULT_VECTOR_MODEL =
  (process.env.MCP_SEARCH_DEFAULT_VECTOR_MODEL ?? 'gemini') as 'gemini' | 'specter2';

/** How many candidates to retrieve before reranking in 'rerank' strategy */
const RERANK_CANDIDATE_COUNT = 15;

const CONTENT_TYPE_ENUM = z.enum([
  'theoretical', 'methodology', 'experimental',
  'results', 'survey', 'background', 'other',
]);

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

export function registerSearch(server: McpServer, ctx: AppContext): void {
  server.tool(
    'search',
    "Hybrid semantic + keyword search across scientific papers. Combines vector similarity with BM25 full-text matching for both conceptual queries and exact terms (paper IDs, author names). Supports filtering by content type (methodology / results / theoretical / etc.), entities, categories, and date range. Default mode for general queries — use 'search_keyword' for exact-term lookups or 'search_semantic' for pure paraphrase queries.",
    {
      query: z.string().describe('Search query text'),
      strategy: z.enum(['fast', 'rerank']).default('fast').describe(
        "'fast' (~1s) for quick lookups; 'rerank' (~10s) applies cross-encoder for higher relevance on complex queries",
      ),
      vectorModel: z.enum(['gemini', 'specter2']).default(DEFAULT_VECTOR_MODEL).describe(
        "'gemini' for general semantic queries (default); 'specter2' for scientific paper similarity",
      ),
      categories: z.array(z.string()).optional()
        .describe('Filter by arXiv categories (e.g. cs.AI, cs.LG)'),
      dateFrom: z.string().optional().describe('Filter: published on or after (ISO date)'),
      dateTo: z.string().optional().describe('Filter: published on or before (ISO date)'),
      contentType: z.array(CONTENT_TYPE_ENUM).optional().describe(
        'Filter chunks by type. Use [methodology] to find HOW researchers approach a problem; [results] for OUTCOMES; [survey, background] for context',
      ),
      entities: z.array(z.string()).optional().describe(
        'Filter chunks mentioning specific entities (method names like "BERT", datasets like "SQuAD", metrics like "BLEU"). Case-insensitive match',
      ),
      diversifyBy: z.enum(['document', 'keyConcept', 'contentType']).default('document').describe(
        "'document' (default): max N chunks per paper. 'keyConcept': diversify by main idea (good for landscape view). 'contentType': mix methodology/results/etc.",
      ),
      maxPerDocument: z.number().int().min(1).max(10).default(2).describe(
        'Max chunks per single key (only when diversifyBy=document)',
      ),
      facets: z.boolean().default(false).describe(
        'If true, return facets block: count breakdown by contentType + top entities mentioned',
      ),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'minimal' = id+title+snippet+score. 'standard' = adds metadata + chunkContext. 'full' = adds entities/selfContained/scores/licenses map",
      ),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results to return'),
    },
    async (params) => {
      const {
        query, strategy, vectorModel, categories, dateFrom, dateTo,
        contentType, entities, diversifyBy, maxPerDocument, facets, detail, limit,
      } = params;

      const { vector, vectorName } = await timed('embed', () => embedQuery(query, vectorModel, ctx));

      const useRerank = strategy === 'rerank';
      // Fetch wider candidate pool when filters likely shrink results
      const hasFilters = !!(categories || dateFrom || dateTo || contentType || entities);
      const candidateCount = useRerank
        ? Math.max(RERANK_CANDIDATE_COUNT, limit * 3)
        : (hasFilters ? Math.max(50, limit * 5) : Math.max(30, limit * 3));

      // Stage 1: Retrieve candidates with hybrid fusion (no diversification at vector layer
      // any more — we do it after chunk-context filters in stage 6)
      const [vectorRaw, bm25Raw] = await Promise.all([
        timed('qdrant', () => ctx.vectorStore.search(vector, vectorName, candidateCount)),
        timed('bm25', () => ctx.searchStore.searchBM25(query, candidateCount)),
      ]);

      const tMerge = performance.now();
      let ranked = mergeHybridResults(vectorRaw, bm25Raw);
      recordStage('merge', performance.now() - tMerge);

      // Stage 2 (rerank only): Cross-encoder reranking
      if (useRerank) {
        const candidates = ranked.slice(0, RERANK_CANDIDATE_COUNT);
        try {
          const passages = candidates.map((c) => c.content);
          const rerankResult = await timed('rerank', () => ctx.rerankerClient.rerank(query, passages));
          ranked = rerankResult.scores.map((s) => ({
            ...candidates[s.index],
            finalScore: s.score,
          }));
        } catch (err) {
          // Graceful degradation
          console.error('[v1/search] Reranker unavailable, falling back to fast:', err instanceof Error ? err.message : err);
        }
      }

      // Stage 3: Hydrate chunk context from PG for chunks lacking markers
      // in Qdrant payload (pre-backfill state).
      let chunks: RankedChunk[] = await timed('hydrate', () => hydrateChunkContexts(ranked as RankedChunk[], ctx));

      // Stage 4: Chunk-context filters (contentType, entities)
      if (contentType || entities) {
        chunks = applyChunkContextFilters(chunks, { contentType, entities });
      }

      // Stage 5: Document-level filters (categories, dates)
      const candidateDocIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await timed('fetch_docs', () => fetchDocuments(candidateDocIds, ctx));

      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const catSet = categories ? new Set(categories) : undefined;

      const tFilter = performance.now();
      chunks = chunks.filter((c) => {
        const doc = docs.get(c.documentId);
        if (!doc) return false;
        if (catSet && !doc.categories.some((cat) => catSet.has(cat))) return false;
        const ms = doc.publishedAt.getTime();
        if (dateFromMs && ms < dateFromMs) return false;
        if (dateToMs && ms > dateToMs) return false;
        return true;
      });

      // Stage 6: Diversify
      const diversified = diversifyChunks(chunks, diversifyBy as DiversifyKey, maxPerDocument);

      // Stage 7: Format per detail
      const top = diversified.slice(0, limit);
      const results = top.map((c) => {
        const doc = docs.get(c.documentId)!;
        return formatSearchResult(c, doc, detail as DetailLevel);
      });
      recordStage('format', performance.now() - tFilter);

      const response: Record<string, unknown> = { results };
      if (facets) {
        const tFacets = performance.now();
        // Compute facets over a wider pool (post-filter, pre-diversify)
        // so agent sees the actual landscape, not the diversified slice.
        response.facets = computeFacets(chunks.slice(0, Math.max(50, limit * 5)));
        recordStage('facets', performance.now() - tFacets);
      }

      // Cache post-filter pool for paginate (Redis 5min TTL).
      // Cache the post-filter, post-document-filter, but PRE-diversify pool
      // so paginate can re-diversify with the original settings.
      const cached = await timed('cache_pool', () => cacheSearchPool(
        chunks,
        detail as DetailLevel,
        diversifyBy as DiversifyKey,
        maxPerDocument,
      ));
      if (cached) {
        // totalCandidates is the post-diversification pool size — the
        // actionable upper bound for paginate offset. paginate re-applies
        // diversifyChunks deterministically on the cached pre-diversify
        // pool, so this number stays stable across calls.
        response.pagination = {
          searchId: cached.searchId,
          totalCandidates: diversified.length,
          expiresAt: cached.expiresAt,
        };
      }

      return jsonResult(response);
    },
  );
}
