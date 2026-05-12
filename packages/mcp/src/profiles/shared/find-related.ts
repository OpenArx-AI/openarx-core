import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { deduplicateByDocument, fetchDocuments, embedQuery, jsonResult, computeCanServeFile } from './helpers.js';

export function registerFindRelated(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_related',
    "Find related papers via three modes: 'similarity' (default — vector similarity to a doc or text), 'byEntity' (papers mentioning a specific entity like \"BERT\"), 'byConcept' (papers sharing a key concept). Returns papers with abstract and metadata for quick understanding — no follow-up get_document needed.",
    {
      mode: z.enum(['similarity', 'byEntity', 'byConcept']).default('similarity').describe(
        "'similarity' (default): vector similarity to documentId or text. 'byEntity': papers mentioning entity (e.g. 'BERT') — ranks by mention count, biases toward surveys that mention the entity many times rather than original papers introducing it; for canonical lookup use search_keyword or find_by_id. 'byConcept': papers sharing keyConcept.",
      ),
      documentId: z.string().optional()
        .describe('For similarity mode (uses doc avg vector)'),
      text: z.string().optional()
        .describe('For similarity mode (embeds text as query)'),
      entity: z.string().optional()
        .describe("For byEntity mode: entity name like 'BERT' or 'ImageNet' (case-insensitive)"),
      concept: z.string().optional()
        .describe('For byConcept mode: keyConcept string (case-insensitive, partial match)'),
      vectorModel: z.enum(['gemini', 'specter2']).default('gemini')
        .describe('Embedding model to use (similarity mode only)'),
      categories: z.array(z.string()).optional()
        .describe('Filter by arXiv categories'),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'minimal' = id+title+score. 'standard' = + abstract + metadata. 'full' = + author records + licenses",
      ),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ mode, documentId, text, entity, concept, vectorModel, categories, detail, limit }) => {
      if (mode === 'similarity') {
        return handleSimilarity(ctx, { documentId, text, vectorModel, categories, detail, limit });
      }
      if (mode === 'byEntity') {
        if (!entity) return jsonResult({ error: 'byEntity mode requires `entity` param' });
        return handleByEntity(ctx, { entity, categories, detail, limit });
      }
      if (mode === 'byConcept') {
        if (!concept) return jsonResult({ error: 'byConcept mode requires `concept` param' });
        return handleByConcept(ctx, { concept, categories, detail, limit });
      }
      return jsonResult({ error: `unknown mode: ${mode}` });
    },
  );
}

interface CommonOpts {
  categories?: string[];
  detail: string;
  limit: number;
}

async function handleSimilarity(
  ctx: AppContext,
  opts: { documentId?: string; text?: string; vectorModel: string; categories?: string[]; detail: string; limit: number },
) {
  const { documentId, text, vectorModel, categories, detail, limit } = opts;
  if (!documentId && !text) {
    return jsonResult({ error: 'similarity mode requires documentId or text' });
  }

  let queryVector: number[];
  let vectorName: string;
  let excludeDocId: string | undefined;

  if (documentId) {
    const srcDoc = await ctx.documentStore.getById(documentId);
    if (!srcDoc || srcDoc.deletedAt) {
      return jsonResult({ error: 'Document not found' });
    }
    const chunks = await ctx.vectorStore.getByDocumentId(documentId);
    if (chunks.length === 0) {
      return jsonResult({ error: 'No chunks found for document' });
    }
    chunks.sort((a, b) => a.context.positionInDocument - b.context.positionInDocument);
    const vec = chunks[0].vectors[vectorModel];
    if (!vec) {
      return jsonResult({ error: `No ${vectorModel} vector found for document chunks` });
    }
    queryVector = vec;
    vectorName = vectorModel;
    excludeDocId = documentId;
  } else {
    const embedded = await embedQuery(text!, vectorModel, ctx);
    queryVector = embedded.vector;
    vectorName = embedded.vectorName;
  }

  const raw = await ctx.vectorStore.search(queryVector, vectorName, (limit + 1) * 3);
  const filtered = excludeDocId ? raw.filter((r) => r.documentId !== excludeDocId) : raw;
  const deduped = deduplicateByDocument(filtered).slice(0, limit * 2);

  const docs = await fetchDocuments(deduped.map((r) => r.documentId), ctx);
  const catSet = categories && categories.length > 0 ? new Set(categories) : null;

  const results = deduped
    .map((r) => {
      const doc = docs.get(r.documentId);
      if (!doc) return null;
      if (catSet && !doc.categories.some((c) => catSet.has(c))) return null;
      return formatRelated(doc, r.score, 'vector_similarity', detail as 'minimal' | 'standard' | 'full');
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, limit);

  return jsonResult({ mode: 'similarity', results });
}

async function handleByEntity(
  ctx: AppContext,
  opts: { entity: string } & CommonOpts,
) {
  const { entity, categories, detail, limit } = opts;
  const params: unknown[] = [entity.toLowerCase()];
  let catFilter = '';
  if (categories && categories.length > 0) {
    params.push(categories);
    catFilter = `AND d.categories && $${params.length}::text[]`;
  }
  params.push(limit);
  // Aggregate: count chunks mentioning entity per document, descending
  const sql = `
    SELECT d.id, count(c.id) AS chunk_count
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(coalesce(c.context->'entities', '[]'::jsonb)) e
      WHERE LOWER(e) = $1
    )
      AND c.is_latest = true
      AND d.status = 'ready'
      AND d.deleted_at IS NULL
      ${catFilter}
    GROUP BY d.id
    ORDER BY chunk_count DESC, d.published_at DESC
    LIMIT $${params.length}
  `;
  const { rows } = await ctx.pool.query<{ id: string; chunk_count: string }>(sql, params);
  const docs = await fetchDocuments(rows.map((r) => r.id), ctx);
  const results = rows.map((r) => {
    const doc = docs.get(r.id);
    if (!doc) return null;
    return formatRelated(doc, parseInt(r.chunk_count, 10), `entity:${entity}`, detail as 'minimal' | 'standard' | 'full');
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return jsonResult({ mode: 'byEntity', entity, results });
}

async function handleByConcept(
  ctx: AppContext,
  opts: { concept: string } & CommonOpts,
) {
  const { concept, categories, detail, limit } = opts;
  const params: unknown[] = [`%${concept.toLowerCase()}%`];
  let catFilter = '';
  if (categories && categories.length > 0) {
    params.push(categories);
    catFilter = `AND d.categories && $${params.length}::text[]`;
  }
  params.push(limit);
  const sql = `
    SELECT d.id, count(c.id) AS chunk_count
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE LOWER(c.context->>'keyConcept') LIKE $1
      AND c.is_latest = true
      AND d.status = 'ready'
      AND d.deleted_at IS NULL
      ${catFilter}
    GROUP BY d.id
    ORDER BY chunk_count DESC, d.published_at DESC
    LIMIT $${params.length}
  `;
  const { rows } = await ctx.pool.query<{ id: string; chunk_count: string }>(sql, params);
  const docs = await fetchDocuments(rows.map((r) => r.id), ctx);
  const results = rows.map((r) => {
    const doc = docs.get(r.id);
    if (!doc) return null;
    return formatRelated(doc, parseInt(r.chunk_count, 10), `concept:${concept}`, detail as 'minimal' | 'standard' | 'full');
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return jsonResult({ mode: 'byConcept', concept, results });
}

function formatRelated(
  doc: import('@openarx/types').Document,
  score: number,
  matchReason: string,
  detail: 'minimal' | 'standard' | 'full',
): Record<string, unknown> {
  if (detail === 'minimal') {
    return {
      documentId: doc.id,
      documentTitle: doc.title,
      score,
      matchReason,
    };
  }

  const abstract = doc.abstract && doc.abstract.length > 500
    ? doc.abstract.slice(0, 500) + '...'
    : doc.abstract ?? null;

  const base: Record<string, unknown> = {
    documentId: doc.id,
    documentTitle: doc.title,
    abstract,
    authors: doc.authors.map((a) => a.name),
    publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
    category: doc.categories[0] ?? null,
    sourceUrl: doc.sourceUrl,
    license: doc.license ?? null,
    indexingTier: doc.indexingTier ?? 'full',
    score,
    matchReason,
  };

  if (detail === 'full') {
    base.authorsFull = doc.authors;
    base.categories = doc.categories;
    base.licenses = doc.licenses ?? {};
    base.canServeFile = computeCanServeFile(doc);
    base.externalIds = doc.externalIds ?? {};
  }
  return base;
}
