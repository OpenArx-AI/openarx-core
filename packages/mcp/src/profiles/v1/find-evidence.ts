import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult, truncateChunk } from '../shared/helpers.js';
import { hydrateChunkContexts, type RankedChunk } from '../shared/search-helpers.js';
import { recordLlm } from '../../lib/usage-tracker.js';

type Relation = 'supporting' | 'contradicting' | 'neutral';

interface ClassifiedChunk extends RankedChunk {
  relation: Relation;
  confidence: number;
}

export function registerFindEvidence(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_evidence',
    "Fact-check or substantiate a claim against the corpus. Given a textual claim, retrieves and CLASSIFIES evidence into supporting / contradicting / neutral groups. Uses HyDE (hypothetical document expansion) — server generates plausible supporting/contradicting text, embeds, retrieves, then ranks by relation to original claim. Returns chunks with selfContained flag (safe-to-cite indicator). Use for fact-verification, controversy mapping, 'is this claim known?' queries. Modes: 'fast' (~3s, score-based grouping) / 'deep' (~10s, adds NLI classification pass for higher precision).",
    {
      claim: z.string().describe('Statement to fact-check or substantiate'),
      mode: z.enum(['fast', 'deep']).default('fast').describe(
        "'fast' (~3s): score-vector-based grouping — APPROXIMATE; may misclassify chunks that mention the topic but logically point the other way (e.g. a paper explaining 'BN is bad in transformers' may land in the contradicting bucket for an 'LN > BN' claim). 'deep' (~10s): adds LLM NLI classification for higher precision. Use 'deep' when classification accuracy matters.",
      ),
      categories: z.array(z.string()).optional(),
      selfContainedOnly: z.boolean().default(false).describe(
        'If true, only return chunks marked as understandable without prior context (safer to cite)',
      ),
      detail: z.enum(['minimal', 'standard', 'full']).default('standard'),
      limit: z.number().int().min(1).max(20).default(5).describe(
        'Max results PER group (supporting/contradicting/neutral)',
      ),
    },
    async ({ claim, mode, categories, selfContainedOnly, detail, limit }) => {
      // Step 1: HyDE — generate hypothetical supporting + contradicting paragraphs
      const [supportingHypo, contradictingHypo] = await Promise.all([
        generateHydeText(ctx, claim, 'supporting'),
        generateHydeText(ctx, claim, 'contradicting'),
      ]);

      // Step 2: embed all 3 (claim + 2 hypotheticals)
      const [claimEmbed, supEmbed, conEmbed] = await Promise.all([
        embedQuery(claim, 'gemini', ctx),
        embedQuery(supportingHypo, 'gemini', ctx),
        embedQuery(contradictingHypo, 'gemini', ctx),
      ]);

      // Step 3: vector search for each (top 20 each)
      const POOL = 20;
      const [claimResults, supResults, conResults] = await Promise.all([
        ctx.vectorStore.search(claimEmbed.vector, claimEmbed.vectorName, POOL),
        ctx.vectorStore.search(supEmbed.vector, supEmbed.vectorName, POOL),
        ctx.vectorStore.search(conEmbed.vector, conEmbed.vectorName, POOL),
      ]);

      // Step 4: pool unique chunks (track which hypo each came from)
      const supScores = new Map<string, number>();
      const conScores = new Map<string, number>();
      const claimScores = new Map<string, number>();
      const all = new Map<string, RankedChunk>();

      const addAll = (results: typeof claimResults, scoreMap: Map<string, number>) => {
        for (const r of results) {
          scoreMap.set(r.chunkId, r.score);
          if (!all.has(r.chunkId)) {
            all.set(r.chunkId, {
              chunkId: r.chunkId,
              documentId: r.documentId,
              content: r.content,
              context: r.context,
              vectorScore: r.score,
              bm25Score: 0,
              finalScore: r.score,
            });
          }
        }
      };
      addAll(claimResults, claimScores);
      addAll(supResults, supScores);
      addAll(conResults, conScores);

      let chunks: RankedChunk[] = [...all.values()];
      chunks = await hydrateChunkContexts(chunks, ctx);

      // Step 5: doc filter
      const docIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await fetchDocuments(docIds, ctx);
      const catSet = categories && categories.length > 0 ? new Set(categories) : null;
      chunks = chunks.filter((c) => {
        const doc = docs.get(c.documentId);
        if (!doc) return false;
        if (catSet && !doc.categories.some((cat) => catSet.has(cat))) return false;
        if (selfContainedOnly && c.context.selfContained !== true) return false;
        return true;
      });

      // Step 6: classify each chunk
      let classified: ClassifiedChunk[];
      if (mode === 'deep') {
        // LLM NLI classification — slow but more accurate
        classified = await Promise.all(chunks.map(async (c) => {
          const { relation, confidence } = await classifyByNLI(ctx, claim, c.content);
          return { ...c, relation, confidence };
        }));
      } else {
        // Fast heuristic: which hypothesis-vector did it score highest against?
        // The differential between supporting-similarity and contradicting-similarity
        // determines the grouping. Magnitude → confidence.
        classified = chunks.map((c) => {
          const sSim = supScores.get(c.chunkId) ?? 0;
          const cSim = conScores.get(c.chunkId) ?? 0;
          const claimSim = claimScores.get(c.chunkId) ?? 0;
          const diff = sSim - cSim;
          let relation: Relation;
          let confidence: number;
          // Threshold tuned empirically: |diff| > 0.05 → confident in direction
          if (Math.abs(diff) < 0.03) {
            relation = 'neutral';
            confidence = 0.5;
          } else if (diff > 0) {
            relation = 'supporting';
            confidence = Math.min(0.95, 0.5 + diff * 4);
          } else {
            relation = 'contradicting';
            confidence = Math.min(0.95, 0.5 + Math.abs(diff) * 4);
          }
          return {
            ...c,
            relation,
            confidence,
            // Pick highest similarity as final ranking score
            finalScore: Math.max(sSim, cSim, claimSim),
          };
        });
      }

      // Step 7: group + sort within group, prefer selfContained=true
      const groups: Record<Relation, ClassifiedChunk[]> = {
        supporting: [],
        contradicting: [],
        neutral: [],
      };
      for (const c of classified) groups[c.relation].push(c);
      for (const k of Object.keys(groups) as Relation[]) {
        groups[k].sort((a, b) => {
          // Prefer selfContained
          const aSc = a.context.selfContained === true ? 1 : 0;
          const bSc = b.context.selfContained === true ? 1 : 0;
          if (aSc !== bSc) return bSc - aSc;
          // Then by confidence × score
          return (b.confidence * b.finalScore) - (a.confidence * a.finalScore);
        });
      }

      const formatGroup = (group: ClassifiedChunk[]) =>
        group.slice(0, limit).map((c) => {
          const doc = docs.get(c.documentId)!;
          if (detail === 'minimal') {
            return {
              documentId: c.documentId,
              documentTitle: doc.title,
              confidence: Number(c.confidence.toFixed(3)),
              selfContained: c.context.selfContained ?? null,
            };
          }
          return {
            documentId: c.documentId,
            documentTitle: doc.title,
            publishedAt: doc.publishedAt instanceof Date ? doc.publishedAt.toISOString() : doc.publishedAt,
            confidence: Number(c.confidence.toFixed(3)),
            chunkContent: truncateChunk(c.content),
            selfContained: c.context.selfContained ?? null,
            chunkContext: {
              summary: c.context.summary ?? null,
              keyConcept: c.context.keyConcept ?? null,
              contentType: c.context.contentType ?? null,
              ...(detail === 'full' ? {
                entities: c.context.entities ?? null,
                sectionPath: c.context.sectionPath ?? null,
              } : {}),
            },
            ...(detail === 'full' ? {
              license: doc.license ?? null,
              authors: doc.authors.map((a) => a.name),
            } : {}),
          };
        });

      return jsonResult({
        claim,
        mode,
        summary: {
          supporting: groups.supporting.length,
          contradicting: groups.contradicting.length,
          neutral: groups.neutral.length,
        },
        supporting: formatGroup(groups.supporting),
        contradicting: formatGroup(groups.contradicting),
        neutral: formatGroup(groups.neutral),
      });
    },
  );
}

async function generateHydeText(
  ctx: AppContext,
  claim: string,
  direction: 'supporting' | 'contradicting',
): Promise<string> {
  const prompt = direction === 'supporting'
    ? `You are writing a paragraph from a hypothetical research paper that demonstrates the claim below as TRUE. Write 3-4 sentences in academic style with technical detail. Do NOT hedge — write as if the claim is established.

Claim: "${claim}"

Hypothetical paragraph:`
    : `You are writing a paragraph from a hypothetical research paper that REFUTES or finds counter-evidence to the claim below. Write 3-4 sentences in academic style with technical detail.

Claim: "${claim}"

Hypothetical refutation paragraph:`;

  try {
    const resp = await ctx.modelRouter.complete('enrichment', prompt, {
      maxTokens: 250,
      temperature: 0.4,
    });
    recordLlm(resp, 'enrichment');
    return resp.text.trim();
  } catch (err) {
    // Fallback: use the claim itself as approximation
    console.error(`[find_evidence] HyDE ${direction} failed:`, err instanceof Error ? err.message : err);
    return claim;
  }
}

async function classifyByNLI(
  ctx: AppContext,
  claim: string,
  chunk: string,
): Promise<{ relation: Relation; confidence: number }> {
  const prompt = `Read the claim and the passage. Determine if the passage SUPPORTS, CONTRADICTS, or is NEUTRAL toward the claim.

Output JSON only:
{
  "relation": "supporting" | "contradicting" | "neutral",
  "confidence": <number 0-1>
}

Claim: "${claim}"

Passage:
"""
${chunk.slice(0, 2000)}
"""

JSON:`;

  try {
    const resp = await ctx.modelRouter.complete('enrichment', prompt, {
      maxTokens: 60,
      temperature: 0.0,
    });
    recordLlm(resp, 'enrichment');
    const match = resp.text.match(/\{[\s\S]*?\}/);
    if (!match) return { relation: 'neutral', confidence: 0.3 };
    const obj = JSON.parse(match[0]);
    const rel = obj.relation;
    const conf = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
    if (rel === 'supporting' || rel === 'contradicting' || rel === 'neutral') {
      return { relation: rel, confidence: conf };
    }
    return { relation: 'neutral', confidence: 0.3 };
  } catch (err) {
    console.error('[find_evidence] NLI classify failed:', err instanceof Error ? err.message : err);
    return { relation: 'neutral', confidence: 0.3 };
  }
}
