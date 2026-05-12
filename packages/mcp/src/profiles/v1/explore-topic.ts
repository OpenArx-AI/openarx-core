import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult, truncateChunk } from '../shared/helpers.js';
import { hydrateChunkContexts, type RankedChunk } from '../shared/search-helpers.js';

export function registerExploreTopic(server: McpServer, ctx: AppContext): void {
  server.tool(
    'explore_topic',
    'Map the conceptual landscape around a topic. Instead of returning a ranked list of papers, returns N distinct conceptual clusters with representative chunks. Built on keyConcept LLM-extracted markers diversification. Use for "what approaches exist to X" queries — answers with thematic map rather than ranked list. Better than search when you want breadth over depth.',
    {
      concept: z.string().describe(
        'Topic or research question to explore (e.g. "in-context learning", "retrieval augmented generation")',
      ),
      clusterCount: z.number().int().min(3).max(15).default(5).describe(
        'Number of distinct conceptual approaches to return',
      ),
      categories: z.array(z.string()).optional().describe('arXiv category filter'),
      dateFrom: z.string().optional().describe('Filter: published on or after (ISO date)'),
      dateTo: z.string().optional().describe('Filter: published on or before (ISO date)'),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard'),
      vectorModel: z.enum(['gemini', 'specter2']).default('gemini'),
    },
    async ({ concept, clusterCount, categories, dateFrom, dateTo, detail, vectorModel }) => {
      const { vector, vectorName } = await embedQuery(concept, vectorModel, ctx);

      // Pull a wide candidate pool — we need enough variety for clustering.
      const POOL_SIZE = Math.max(80, clusterCount * 12);
      const vectorRaw = await ctx.vectorStore.search(vector, vectorName, POOL_SIZE);

      let chunks: RankedChunk[] = vectorRaw.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        content: r.content,
        context: r.context,
        vectorScore: r.score,
        bm25Score: 0,
        finalScore: r.score,
      }));

      // Hydrate keyConcept from PG for chunks where Qdrant payload lacks it.
      chunks = await hydrateChunkContexts(chunks, ctx);

      // Apply doc-level filters
      const docIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await fetchDocuments(docIds, ctx);
      const dateFromMs = dateFrom ? new Date(dateFrom).getTime() : undefined;
      const dateToMs = dateTo ? new Date(dateTo).getTime() : undefined;
      const catSet = categories && categories.length > 0 ? new Set(categories) : null;

      chunks = chunks.filter((c) => {
        const doc = docs.get(c.documentId);
        if (!doc) return false;
        if (catSet && !doc.categories.some((cat) => catSet.has(cat))) return false;
        const ms = doc.publishedAt.getTime();
        if (dateFromMs && ms < dateFromMs) return false;
        if (dateToMs && ms > dateToMs) return false;
        return true;
      });

      // Group by keyConcept (case-insensitive). Chunks lacking keyConcept
      // fall into a synthetic "unlabeled" cluster (excluded from results).
      const byConcept = new Map<string, RankedChunk[]>();
      for (const c of chunks) {
        const kc = c.context.keyConcept?.trim();
        if (!kc) continue;
        const key = kc.toLowerCase();
        if (!byConcept.has(key)) byConcept.set(key, []);
        byConcept.get(key)!.push(c);
      }

      // Score clusters: by max-chunk-score within cluster (relevance) and
      // chunk-count (volume). Sort by relevance×log(volume).
      const clusterRanked = [...byConcept.entries()].map(([_keyLower, clusterChunks]) => {
        const top = clusterChunks.reduce((a, b) => a.finalScore > b.finalScore ? a : b);
        const score = top.finalScore * Math.log2(clusterChunks.length + 1);
        return { keyLower: _keyLower, originalKey: top.context.keyConcept ?? '', clusterChunks, top, score };
      }).sort((a, b) => b.score - a.score);

      const topClusters = clusterRanked.slice(0, clusterCount);

      const clusters = topClusters.map((cl) => {
        const top = cl.top;
        const topDoc = docs.get(top.documentId);
        // Top 2 unique papers in cluster
        const seen = new Set<string>();
        const topPapers: Array<{ documentId: string; title: string }> = [];
        for (const c of [...cl.clusterChunks].sort((a, b) => b.finalScore - a.finalScore)) {
          if (seen.has(c.documentId)) continue;
          seen.add(c.documentId);
          const d = docs.get(c.documentId);
          if (d) topPapers.push({ documentId: c.documentId, title: d.title });
          if (topPapers.length >= 2) break;
        }

        if (detail === 'minimal') {
          return {
            cluster_concept: cl.originalKey,
            paperCount: seen.size,
            topPaperTitle: topDoc?.title ?? null,
          };
        }

        const base: Record<string, unknown> = {
          cluster_concept: cl.originalKey,
          paperCount: new Set(cl.clusterChunks.map((c) => c.documentId)).size,
          chunkCount: cl.clusterChunks.length,
          representativeChunk: {
            documentId: top.documentId,
            documentTitle: topDoc?.title ?? null,
            chunkContent: truncateChunk(top.content),
            summary: top.context.summary ?? null,
            score: top.finalScore,
          },
          topPapers,
        };

        if (detail === 'full') {
          // Include contentType breakdown + entities for cluster
          const ctCounts: Record<string, number> = {};
          const entitySet = new Set<string>();
          for (const c of cl.clusterChunks) {
            const ct = c.context.contentType;
            if (ct) ctCounts[ct] = (ctCounts[ct] ?? 0) + 1;
            for (const e of c.context.entities ?? []) entitySet.add(e);
          }
          base.contentTypeBreakdown = ctCounts;
          base.entities = [...entitySet].slice(0, 15);
        }
        return base;
      });

      return jsonResult({
        concept,
        totalClustersFound: clusterRanked.length,
        clusters,
      });
    },
  );
}
