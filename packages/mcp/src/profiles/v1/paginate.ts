import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { fetchDocuments, jsonResult } from '../shared/helpers.js';
import {
  loadCachedSearchPool,
  diversifyChunks,
  formatSearchResult,
} from '../shared/search-helpers.js';

export function registerPaginate(server: McpServer, ctx: AppContext): void {
  server.tool(
    'paginate',
    'Continue from a previous search without re-running the full pipeline. Pass the `searchId` returned in any search response and an offset to fetch more results from the cached candidate pool. Cached for 5 minutes — for older searches re-run the original tool.',
    {
      searchId: z.string().uuid().describe(
        'searchId from a previous search / search_keyword / search_semantic response',
      ),
      offset: z.number().int().min(0).describe(
        'Skip first N results (e.g. 10 to get next page after limit=10 first call)',
      ),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ searchId, offset, limit }) => {
      const cached = await loadCachedSearchPool(searchId);
      if (!cached) {
        return jsonResult({
          error: 'Search pool not found or expired (5min TTL). Re-run the original search.',
        });
      }

      // Re-diversify the entire pool with original settings, then slice.
      // Diversification is idempotent and cheap on already-ranked data.
      const diversified = diversifyChunks(cached.pool, cached.diversifyBy, cached.maxPerKey);
      const slice = diversified.slice(offset, offset + limit);

      const docIds = [...new Set(slice.map((c) => c.documentId))];
      const docs = await fetchDocuments(docIds, ctx);

      const results = slice
        .map((c) => {
          const doc = docs.get(c.documentId);
          if (!doc) return null;
          return formatSearchResult(c, doc, cached.detail);
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      return jsonResult({
        results,
        pagination: {
          searchId,
          offset,
          limit,
          returned: results.length,
          totalCandidates: diversified.length,
          expiresAt: cached.expiresAt,
        },
      });
    },
  );
}
