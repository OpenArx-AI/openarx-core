import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChunkContext } from '@openarx/types';
import type { AppContext } from '../../context.js';
import { jsonResult, formatDoc, truncateChunk } from './helpers.js';
import { loadCachedSearchPool } from './search-helpers.js';

const CONTENT_TYPE_ENUM = z.enum([
  'theoretical', 'methodology', 'experimental',
  'results', 'survey', 'background', 'other',
]);

interface ChunkRow {
  id: string;
  content: string;
  context: ChunkContext;
  position: number | null;
  section_path: string | null;
}

export function registerGetDocument(server: McpServer, ctx: AppContext): void {
  server.tool(
    'get_document',
    "Retrieve full paper details by ID. Default returns metadata only (title, authors, abstract, license, codeLinks counts) — use includeChunks=true to fetch chunk content. For specific sections or content types, use chunkContentTypes/section filters or call get_chunks instead. For long papers, prefer filtered chunk retrieval over full chunks dump.",
    {
      id: z.string().optional().describe('Document UUID'),
      arxivId: z.string().optional().describe('arXiv ID (e.g. 1706.03762)'),
      includeChunks: z.boolean().default(false).describe(
        'DEFAULT FALSE — metadata only. Set true for chunk content. Combine with chunkContentTypes/chunkLimit for filtered retrieval. (search v2 changed default; pre-2026-05 v1 always returned chunks.)',
      ),
      chunkContentTypes: z.array(CONTENT_TYPE_ENUM).optional().describe(
        'Filter chunks by type. Implies includeChunks=true.',
      ),
      chunkLimit: z.number().int().min(1).max(200).default(20).describe(
        'Max chunks returned when includeChunks=true (or filter is set)',
      ),
      chunkOrder: z.enum(['position', 'importance']).default('position').describe(
        "'position' (default): document order. 'importance': search relevance order — requires searchId from a prior search response; falls back to position with a note when searchId is missing or expired.",
      ),
      searchId: z.string().uuid().optional().describe(
        'searchId from a prior search / search_keyword / search_semantic response. Required when chunkOrder=importance.',
      ),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard'),
    },
    async ({ id, arxivId, includeChunks, chunkContentTypes, chunkLimit, chunkOrder, searchId, detail }, _extra) => {
      if (!id && !arxivId) {
        return jsonResult({ error: 'Provide either id or arxivId' });
      }

      const doc = id
        ? await ctx.documentStore.getById(id)
        : await ctx.documentStore.getBySourceId('arxiv', arxivId!);

      if (!doc || doc.deletedAt) {
        return jsonResult({ error: 'Document not found' });
      }

      // Detect old-default invocation: agent passed neither includeChunks nor
      // chunk filters → would have received chunks in v1, now gets metadata.
      // Surface explicit deprecation warning so existing demo agents/test users
      // notice the change.
      const usedOldDefault = includeChunks === false && !chunkContentTypes;

      // Implicit: chunkContentTypes set → user wants chunks
      const wantChunks = includeChunks || (chunkContentTypes && chunkContentTypes.length > 0);

      const docFormatted = formatDocByDetail(doc, detail);

      const response: Record<string, unknown> = {
        document: docFormatted,
      };

      if (wantChunks) {
        const conds: string[] = ['document_id = $1', 'is_latest = true'];
        const params: unknown[] = [doc.id];
        if (chunkContentTypes && chunkContentTypes.length > 0) {
          params.push(chunkContentTypes);
          conds.push(`context->>'contentType' = ANY($${params.length}::text[])`);
        }

        // Importance ordering: chunkIds from cached search pool filtered to this doc
        let importanceOrder: string[] | null = null;
        let importanceFallbackReason: string | null = null;
        if (chunkOrder === 'importance') {
          if (!searchId) {
            importanceFallbackReason = 'chunkOrder=importance requires searchId — fell back to position';
          } else {
            const cached = await loadCachedSearchPool(searchId);
            if (!cached) {
              importanceFallbackReason = 'searchId not found or expired (5min TTL) — fell back to position';
            } else {
              importanceOrder = cached.pool
                .filter((c) => c.documentId === doc.id)
                .map((c) => c.chunkId);
              if (importanceOrder.length === 0) {
                importanceFallbackReason = 'document has no chunks in the cached search pool — fell back to position';
                importanceOrder = null;
              }
            }
          }
        }

        let rows: ChunkRow[];
        if (importanceOrder && importanceOrder.length > 0) {
          params.push(importanceOrder);
          conds.push(`id = ANY($${params.length}::uuid[])`);
          params.push(chunkLimit);
          const sql = `
            SELECT id, content, context, position, section_path
            FROM chunks
            WHERE ${conds.join(' AND ')}
            ORDER BY array_position($${params.length - 1}::uuid[], id)
            LIMIT $${params.length}
          `;
          const r = await ctx.pool.query<ChunkRow>(sql, params);
          rows = r.rows;
        } else {
          params.push(chunkLimit);
          const sql = `
            SELECT id, content, context, position, section_path
            FROM chunks
            WHERE ${conds.join(' AND ')}
            ORDER BY position NULLS LAST
            LIMIT $${params.length}
          `;
          const r = await ctx.pool.query<ChunkRow>(sql, params);
          rows = r.rows;
        }

        response.chunks = rows.map((r) => formatChunk(r, detail));
        response.chunkOrder = importanceOrder ? 'importance' : 'position';
        if (importanceFallbackReason) response.chunkOrderNote = importanceFallbackReason;

        // Total chunk count (independent of filter)
        const totalRes = await ctx.pool.query<{ count: string }>(
          `SELECT count(*)::text FROM chunks WHERE document_id = $1 AND is_latest = true`,
          [doc.id],
        );
        response.totalChunks = parseInt(totalRes.rows[0]?.count ?? '0', 10);
        response.matchedChunks = rows.length;
      } else {
        // Metadata-only path — surface helpful counts so agents don't
        // need a follow-up call to know whether body content exists
        const cntRes = await ctx.pool.query<{ count: string }>(
          `SELECT count(*)::text FROM chunks WHERE document_id = $1 AND is_latest = true`,
          [doc.id],
        );
        response.totalChunks = parseInt(cntRes.rows[0]?.count ?? '0', 10);
        response.hasCode = doc.codeLinks.length > 0;
        response.hasDatasets = doc.datasetLinks.length > 0;
        response.hasBenchmarks = doc.benchmarkResults.length > 0;
      }

      if (usedOldDefault) {
        response._deprecation = "v2 default returns no chunks (used to return all). Pass includeChunks=true if you need chunk content, or use get_chunks/find_methodology/etc. for targeted retrieval. This warning will be removed after 2026-08-01.";
      }

      return jsonResult(response);
    },
  );
}

function formatDocByDetail(
  doc: import('@openarx/types').Document,
  detail: 'minimal' | 'standard' | 'full',
): Record<string, unknown> {
  if (detail === 'minimal') {
    return {
      id: doc.id,
      title: doc.title,
      publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
      category: doc.categories[0] ?? null,
    };
  }

  if (detail === 'full') {
    // Identical to legacy formatDoc — preserves existing v1 shape for
    // callers needing complete metadata.
    return formatDoc(doc);
  }

  // standard — trim multi-source map, full author records, externalIds
  return {
    id: doc.id,
    title: doc.title,
    authors: doc.authors.map((a) => a.name),
    abstract: doc.abstract,
    categories: doc.categories,
    publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
    sourceUrl: doc.sourceUrl,
    sourceId: doc.sourceId,
    license: doc.license ?? null,
    indexingTier: doc.indexingTier ?? 'full',
    codeLinks: doc.codeLinks,
    datasetLinks: doc.datasetLinks,
    benchmarkResults: doc.benchmarkResults,
  };
}

function formatChunk(
  row: ChunkRow,
  detail: 'minimal' | 'standard' | 'full',
): Record<string, unknown> {
  const ctx = row.context;
  if (detail === 'minimal') {
    return {
      chunkId: row.id,
      sectionPath: row.section_path ?? ctx.sectionPath ?? null,
      summary: ctx.summary ?? null,
    };
  }

  const base: Record<string, unknown> = {
    chunkId: row.id,
    content: truncateChunk(row.content),
    context: {
      sectionPath: row.section_path ?? ctx.sectionPath ?? null,
      sectionName: ctx.sectionName ?? null,
      position: row.position ?? ctx.positionInDocument ?? 0,
      summary: ctx.summary ?? null,
      keyConcept: ctx.keyConcept ?? null,
      contentType: ctx.contentType ?? null,
    },
  };

  if (detail === 'full') {
    (base.context as Record<string, unknown>).entities = ctx.entities ?? null;
    (base.context as Record<string, unknown>).selfContained = ctx.selfContained ?? null;
    (base.context as Record<string, unknown>).totalChunks = ctx.totalChunks ?? null;
  }
  return base;
}
