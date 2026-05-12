import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { fetchDocuments, jsonResult } from '../shared/helpers.js';
import { recordLlm } from '../../lib/usage-tracker.js';

interface ChunkRow {
  document_id: string;
  context: {
    contentType?: string;
    keyConcept?: string;
    entities?: string[];
    summary?: string;
  };
}

export function registerComparePapers(server: McpServer, ctx: AppContext): void {
  server.tool(
    'compare_papers',
    'Generate side-by-side comparison of 2-5 papers. Returns structured grid: shared entities (intersection), per-paper unique entities, contentType breakdown, top keyConcepts. Built on LLM-extracted entities + chunk classifications. Use for systematic literature review, surveying competing approaches, identifying research gaps between methods.',
    {
      documentIds: z.array(z.string().uuid()).min(2).max(5).describe(
        'Documents to compare (UUIDs). Minimum 2, maximum 5.',
      ),
      dimensions: z.array(z.enum(['entities', 'concepts', 'contentTypes', 'methods', 'datasets']))
        .default(['entities', 'concepts', 'contentTypes'])
        .describe('Which comparison dimensions to compute'),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard').describe(
        "'minimal' = entity intersection sizes only. 'standard' = full per-doc breakdowns. 'full' = + benchmark/code/dataset cross-comparison",
      ),
    },
    async ({ documentIds, dimensions, detail }) => {
      const docs = await fetchDocuments(documentIds, ctx);
      const orderedDocs = documentIds.map((id) => docs.get(id)).filter((d): d is NonNullable<typeof d> => !!d);
      if (orderedDocs.length < 2) {
        return jsonResult({ error: `Found only ${orderedDocs.length} of ${documentIds.length} documents (rest deleted or missing). Need at least 2.` });
      }

      // Load all chunks.context for these docs in a single query
      const { rows } = await ctx.pool.query<ChunkRow>(
        `SELECT document_id, context FROM chunks WHERE document_id = ANY($1::uuid[]) AND is_latest = true`,
        [orderedDocs.map((d) => d.id)],
      );

      const perDocAgg = new Map<string, {
        entities: Set<string>;
        keyConcepts: Map<string, number>;
        contentTypes: Map<string, number>;
        chunkCount: number;
      }>();
      for (const d of orderedDocs) {
        perDocAgg.set(d.id, {
          entities: new Set(),
          keyConcepts: new Map(),
          contentTypes: new Map(),
          chunkCount: 0,
        });
      }
      for (const row of rows) {
        const agg = perDocAgg.get(row.document_id);
        if (!agg) continue;
        agg.chunkCount++;
        for (const e of row.context.entities ?? []) {
          agg.entities.add(e);
        }
        const kc = row.context.keyConcept;
        if (kc) agg.keyConcepts.set(kc, (agg.keyConcepts.get(kc) ?? 0) + 1);
        const ct = row.context.contentType;
        if (ct) agg.contentTypes.set(ct, (agg.contentTypes.get(ct) ?? 0) + 1);
      }

      // Compute shared / divergent
      const allEntitySets = orderedDocs.map((d) => perDocAgg.get(d.id)!.entities);
      const sharedEntities = allEntitySets.length > 0
        ? [...allEntitySets[0]].filter((e) => allEntitySets.every((s) => s.has(e)))
        : [];

      const allKcSets = orderedDocs.map((d) =>
        new Set([...perDocAgg.get(d.id)!.keyConcepts.keys()]),
      );
      const sharedKeyConcepts = allKcSets.length > 0
        ? [...allKcSets[0]].filter((k) => allKcSets.every((s) => s.has(k)))
        : [];

      // Per-doc unique entities (entities not present in ANY other doc)
      const divergentEntities: Record<string, string[]> = {};
      for (let i = 0; i < orderedDocs.length; i++) {
        const docId = orderedDocs[i].id;
        const mySet = allEntitySets[i];
        const others = allEntitySets.filter((_, j) => j !== i);
        divergentEntities[docId] = [...mySet].filter(
          (e) => !others.some((s) => s.has(e)),
        ).slice(0, 20); // cap at 20 per doc
      }

      // Per-doc top keyConcepts
      const topConceptsPerDoc: Record<string, string[]> = {};
      for (const doc of orderedDocs) {
        const agg = perDocAgg.get(doc.id)!;
        const top = [...agg.keyConcepts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k]) => k);
        topConceptsPerDoc[doc.id] = top;
      }

      // ContentType breakdown
      const contentTypeBreakdown: Record<string, Record<string, number>> = {};
      for (const doc of orderedDocs) {
        const agg = perDocAgg.get(doc.id)!;
        contentTypeBreakdown[doc.id] = Object.fromEntries(agg.contentTypes);
      }

      const papers = orderedDocs.map((d) => {
        const agg = perDocAgg.get(d.id)!;
        return {
          documentId: d.id,
          title: d.title,
          year: d.publishedAt instanceof Date ? d.publishedAt.getUTCFullYear() : null,
          chunkCount: agg.chunkCount,
          topConcepts: topConceptsPerDoc[d.id],
        };
      });

      const dimSet = new Set(dimensions);

      const response: Record<string, unknown> = { papers };

      if (dimSet.has('entities')) {
        if (detail === 'minimal') {
          response.shared = { entities: sharedEntities.length };
        } else {
          response.shared = { entities: sharedEntities };
          response.divergent = { entities: divergentEntities };
        }
      }
      if (dimSet.has('concepts') && detail !== 'minimal') {
        (response.shared as Record<string, unknown>).keyConcepts = sharedKeyConcepts;
      }
      if (dimSet.has('contentTypes') && detail !== 'minimal') {
        response.contentTypeDistribution = contentTypeBreakdown;
      }

      if (detail === 'full') {
        // Cross-comparison of code/dataset/benchmark mentions
        if (dimSet.has('methods') || dimSet.has('datasets')) {
          response.assets = orderedDocs.map((d) => ({
            documentId: d.id,
            codeLinkCount: d.codeLinks.length,
            datasetLinkCount: d.datasetLinks.length,
            benchmarkResultCount: d.benchmarkResults.length,
            datasets: d.datasetLinks.map((dl) => dl.name).slice(0, 5),
            tasks: [...new Set(d.benchmarkResults.map((b) => b.task))].slice(0, 5),
          }));
        }

        // LLM-generated comparison summary — best-effort. Builds a compact
        // prompt from per-doc top concepts + shared/divergent entities and
        // asks for 2-4 sentences of contrastive narrative. Failure is
        // non-fatal: comparisonSummary stays absent.
        try {
          response.comparisonSummary = await summarizeComparison(
            ctx,
            orderedDocs,
            topConceptsPerDoc,
            sharedEntities,
            divergentEntities,
          );
        } catch (err) {
          console.error('[compare_papers] summary LLM failed:', err instanceof Error ? err.message : err);
        }
      }

      return jsonResult(response);
    },
  );
}

async function summarizeComparison(
  ctx: AppContext,
  docs: import('@openarx/types').Document[],
  topConceptsPerDoc: Record<string, string[]>,
  sharedEntities: string[],
  divergentEntities: Record<string, string[]>,
): Promise<string | null> {
  const lines: string[] = [];
  for (const d of docs) {
    const concepts = topConceptsPerDoc[d.id]?.slice(0, 4).join(', ') || '(no concepts)';
    const unique = divergentEntities[d.id]?.slice(0, 6).join(', ') || '(none)';
    const year = d.publishedAt instanceof Date ? d.publishedAt.getUTCFullYear() : '?';
    lines.push(`- ${d.title} (${year}): top concepts: ${concepts}; unique entities: ${unique}`);
  }
  const sharedLine = sharedEntities.length > 0
    ? sharedEntities.slice(0, 8).join(', ')
    : '(no shared entities across all papers)';

  const prompt = `Write a concise contrastive comparison (2-4 sentences) of these research papers. Focus on what distinguishes them and what they share. Avoid restating titles.

Papers:
${lines.join('\n')}

Shared entities across all: ${sharedLine}

Comparison:`;

  const resp = await ctx.modelRouter.complete('enrichment', prompt, {
    maxTokens: 350,
    temperature: 0.3,
  });
  recordLlm(resp, 'enrichment');
  const text = resp.text.trim();
  return text.length > 0 ? text : null;
}
