import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { fetchDocuments, jsonResult } from '../shared/helpers.js';
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

const CONTENT_TYPE_ENUM = z.enum([
  'theoretical', 'methodology', 'experimental',
  'results', 'survey', 'background', 'other',
]);

export function registerSearchKeyword(server: McpServer, ctx: AppContext): void {
  server.tool(
    'search_keyword',
    'Pure keyword (BM25) search — fastest option, optimal for exact-term lookups: paper titles, author names, method names (e.g. "LoRA", "RLHF"), arXiv IDs. Does NOT use semantic vectors. Use this when you know the specific term you\'re looking for. For paraphrased or conceptual queries, prefer "search_semantic" or "search".',
    {
      query: z.string().describe(
        'Search query — exact terms work best (method names, IDs, titles). NOTE: BM25 ranks by chunk-level term frequency; for canonical paper lookup by exact name (e.g. "LoRA" → original LoRA paper), prefer find_by_id by arxivId or title-search. This tool may surface papers that mention the term frequently but are not the canonical source.',
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
        query, categories, dateFrom, dateTo, contentType, entities,
        diversifyBy, maxPerDocument, facets, detail, limit,
      } = params;

      const hasFilters = !!(categories || dateFrom || dateTo || contentType || entities);
      const candidateCount = hasFilters ? Math.max(50, limit * 5) : Math.max(30, limit * 3);

      // BM25-only — no embed call, no Qdrant search
      const bm25Raw = await ctx.searchStore.searchBM25(query, candidateCount);

      let chunks: RankedChunk[] = bm25Raw.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        content: r.content,
        context: r.context,
        vectorScore: 0,
        bm25Score: r.bm25Score,
        finalScore: r.bm25Score,
      }));

      chunks = await hydrateChunkContexts(chunks, ctx);

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
