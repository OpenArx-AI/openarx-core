import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult } from '../shared/helpers.js';
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

const DEFAULT_VECTOR_MODEL =
  (process.env.MCP_SEARCH_DEFAULT_VECTOR_MODEL ?? 'gemini') as 'gemini' | 'specter2';

const RERANK_CANDIDATE_COUNT = 15;

const CONTENT_TYPE_ENUM = z.enum([
  'theoretical', 'methodology', 'experimental',
  'results', 'survey', 'background', 'other',
]);

export function registerSearchSemantic(server: McpServer, ctx: AppContext): void {
  server.tool(
    'search_semantic',
    'Pure semantic (vector) search — best for paraphrased queries, concept exploration, "papers arguing X" type questions. Uses dense vector similarity via Gemini or SPECTER2 embeddings. Skips BM25 fusion which can introduce term-matching noise. For exact terms use "search_keyword". For mixed queries use "search".',
    {
      query: z.string().describe('Search query — concepts, paraphrased ideas, "papers arguing X"'),
      strategy: z.enum(['fast', 'rerank']).default('fast').describe(
        "'fast' (~1s) skips reranker; 'rerank' (~10s) applies cross-encoder for higher relevance",
      ),
      vectorModel: z.enum(['gemini', 'specter2']).default(DEFAULT_VECTOR_MODEL).describe(
        "'gemini' for general semantic queries (default); 'specter2' for scientific paper similarity",
      ),
      categories: z.array(z.string()).optional()
        .describe('Filter by arXiv categories (e.g. cs.AI, cs.LG)'),
      dateFrom: z.string().optional().describe('Filter: published on or after (ISO date)'),
      dateTo: z.string().optional().describe('Filter: published on or before (ISO date)'),
      contentType: z.array(CONTENT_TYPE_ENUM).optional().describe(
        'Filter chunks by type. Use [methodology] for HOW researchers approach a problem; [results] for OUTCOMES; [survey, background] for context',
      ),
      entities: z.array(z.string()).optional().describe(
        'Filter chunks mentioning specific entities (method names like "BERT", datasets like "SQuAD", metrics like "BLEU"). Case-insensitive match',
      ),
      diversifyBy: z.enum(['document', 'keyConcept', 'contentType']).default('document').describe(
        "'document' (default): max N chunks per paper. 'keyConcept': diversify by main idea. 'contentType': mix methodology/results/etc.",
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

      const { vector, vectorName } = await embedQuery(query, vectorModel, ctx);

      const useRerank = strategy === 'rerank';
      const hasFilters = !!(categories || dateFrom || dateTo || contentType || entities);
      const candidateCount = useRerank
        ? Math.max(RERANK_CANDIDATE_COUNT, limit * 3)
        : (hasFilters ? Math.max(50, limit * 5) : Math.max(30, limit * 3));

      // Vector-only retrieval
      const vectorRaw = await ctx.vectorStore.search(vector, vectorName, candidateCount);

      let ranked: RankedChunk[] = vectorRaw.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        content: r.content,
        context: r.context,
        vectorScore: r.score,
        bm25Score: 0,
        finalScore: r.score,
      }));

      // Optional rerank
      if (useRerank) {
        const candidates = ranked.slice(0, RERANK_CANDIDATE_COUNT);
        try {
          const passages = candidates.map((c) => c.content);
          const rerankResult = await ctx.rerankerClient.rerank(query, passages);
          ranked = rerankResult.scores.map((s) => ({
            ...candidates[s.index],
            finalScore: s.score,
          }));
        } catch (err) {
          console.error('[v1/search_semantic] Reranker unavailable, fast fallback:', err instanceof Error ? err.message : err);
        }
      }

      let chunks = await hydrateChunkContexts(ranked, ctx);

      if (contentType || entities) {
        chunks = applyChunkContextFilters(chunks, { contentType, entities });
      }

      const candidateDocIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await fetchDocuments(candidateDocIds, ctx);

      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const catSet = categories ? new Set(categories) : undefined;

      chunks = chunks.filter((c) => {
        const doc = docs.get(c.documentId);
        if (!doc) return false;
        if (catSet && !doc.categories.some((cat) => catSet.has(cat))) return false;
        const ms = doc.publishedAt.getTime();
        if (dateFromMs && ms < dateFromMs) return false;
        if (dateToMs && ms > dateToMs) return false;
        return true;
      });

      const diversified = diversifyChunks(chunks, diversifyBy as DiversifyKey, maxPerDocument);
      const top = diversified.slice(0, limit);
      const results = top.map((c) => formatSearchResult(c, docs.get(c.documentId)!, detail as DetailLevel));

      const response: Record<string, unknown> = { results };
      if (facets) {
        response.facets = computeFacets(chunks.slice(0, Math.max(50, limit * 5)));
      }
      const cached = await cacheSearchPool(
        chunks,
        detail as DetailLevel,
        diversifyBy as DiversifyKey,
        maxPerDocument,
      );
      if (cached) {
        // Post-diversification count — must match paginate's number.
        // See search.ts for the contract rationale.
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
