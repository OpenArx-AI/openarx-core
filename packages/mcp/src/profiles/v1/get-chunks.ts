import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChunkContext } from '@openarx/types';
import type { AppContext } from '../../context.js';
import { jsonResult, truncateChunk } from '../shared/helpers.js';
import { loadCachedSearchPool } from '../shared/search-helpers.js';

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

export function registerGetChunks(server: McpServer, ctx: AppContext): void {
  server.tool(
    'get_chunks',
    'Retrieve specific chunks from a known document with filters: by content type, section, or entity mention. Use after `search` or `find_methodology` returned a relevant paper and you want more chunks from it without re-running search. Direct PG fetch — no vector search latency.',
    {
      documentId: z.string().uuid().describe('Document UUID (from a prior search result)'),
      contentType: z.array(CONTENT_TYPE_ENUM).optional().describe(
        'Filter chunks by type (methodology / results / theoretical / experimental / survey / background / other)',
      ),
      section: z.string().optional().describe(
        'Section name or path prefix (e.g. "Methods" or "3.")',
      ),
      entities: z.array(z.string()).optional().describe(
        'Only chunks mentioning these entities (case-insensitive ANY match)',
      ),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'minimal' = section + summary only. 'standard' = + content. 'full' = + entities/selfContained/totalChunks",
      ),
      chunkOrder: z.enum(['position', 'importance']).default('position').describe(
        "'position' (default): document order. 'importance': search relevance order — requires searchId from a prior search response; falls back to position with a note when searchId is missing or expired.",
      ),
      searchId: z.string().uuid().optional().describe(
        'searchId from a prior search / search_keyword / search_semantic response. Required when chunkOrder=importance.',
      ),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ documentId, contentType, section, entities, detail, chunkOrder, searchId, limit }) => {
      // Soft-delete check on document
      const doc = await ctx.documentStore.getById(documentId);
      if (!doc || doc.deletedAt) {
        return jsonResult({ error: 'Document not found' });
      }

      // Build query with filters
      const conds: string[] = ['document_id = $1', 'is_latest = true'];
      const params: unknown[] = [documentId];

      if (contentType && contentType.length > 0) {
        params.push(contentType);
        conds.push(`context->>'contentType' = ANY($${params.length}::text[])`);
      }
      if (section) {
        params.push(`${section}%`);
        conds.push(`(section_path ILIKE $${params.length} OR context->>'sectionPath' ILIKE $${params.length})`);
      }
      if (entities && entities.length > 0) {
        // Match any entity in chunk's entities array (case-insensitive)
        params.push(entities.map((e) => e.toLowerCase()));
        conds.push(`EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(coalesce(context->'entities', '[]'::jsonb)) e
          WHERE LOWER(e) = ANY($${params.length}::text[])
        )`);
      }

      const totalRes = await ctx.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM chunks WHERE document_id = $1 AND is_latest = true`,
        [documentId],
      );
      const totalChunks = parseInt(totalRes.rows[0]?.count ?? '0', 10);

      // Importance ordering: pull chunkId order from cached search pool
      // (filtered to this document, already sorted by score). PG fetch uses
      // id = ANY(...) and array_position(...) for stable ordering. Falls
      // back to position when cache is missing/expired.
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
              .filter((c) => c.documentId === documentId)
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
        // Restrict to chunks present in the cached pool, intersected with
        // existing filters; order matches search-relevance.
        params.push(importanceOrder);
        conds.push(`id = ANY($${params.length}::uuid[])`);
        params.push(limit);
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
        params.push(limit);
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

      const chunks = rows.map((r) => formatChunk(r, detail as 'minimal' | 'standard' | 'full'));

      const response: Record<string, unknown> = {
        documentId,
        documentTitle: doc.title,
        totalChunks,
        matched: rows.length,
        chunkOrder: importanceOrder ? 'importance' : 'position',
        chunks,
      };
      if (importanceFallbackReason) response.chunkOrderNote = importanceFallbackReason;
      return jsonResult(response);
    },
  );
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
