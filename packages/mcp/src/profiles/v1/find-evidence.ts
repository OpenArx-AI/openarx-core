import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retry } from '@openarx/api';
import type { AppContext } from '../../context.js';
import { embedQuery, fetchDocuments, jsonResult, truncateChunk } from '../shared/helpers.js';
import { hydrateChunkContexts, type RankedChunk } from '../shared/search-helpers.js';
import { recordLlm, timed } from '../../lib/usage-tracker.js';

type Relation = 'supporting' | 'contradicting' | 'neutral';

interface ClassifiedChunk extends RankedChunk {
  relation: Relation;
  confidence: number;
}

// HyDE output shorter than this is treated as refusal/garbage and we fall back
// to the claim itself. Academic paragraphs (3-4 sentences) are 200+ chars; the
// threshold of 20 cleanly filters empty strings, "I can't help with that"-style
// refusals, and truncated single-word replies.
const HYDE_MIN_USABLE_CHARS = 20;

export function registerFindEvidence(server: McpServer, ctx: AppContext): void {
  server.tool(
    'find_evidence',
    "Fact-check or substantiate a claim against the corpus. Given a textual claim, retrieves and CLASSIFIES evidence into supporting / contradicting / neutral groups. Uses HyDE (hypothetical document expansion) — server generates plausible supporting/contradicting text, embeds, retrieves, then ranks by relation to original claim. Returns chunks with selfContained flag (safe-to-cite indicator). Use for fact-verification, controversy mapping, 'is this claim known?' queries. Modes: 'fast' (~3s, symmetric-by-construction grouping) / 'deep' (~10s, independent NLI classification). IMPORTANT: in 'fast' mode the supporting/contradicting counts are approximately balanced BY CONSTRUCTION and do NOT reflect actual literature distribution. Use 'deep' when measuring controversy balance, literature distribution, or any claim of the form 'the field is split N:M on this'.",
    {
      claim: z.string().describe('Statement to fact-check or substantiate'),
      mode: z.enum(['fast', 'deep']).default('fast').describe(
        "'fast' (~3s): retrieval uses symmetric HyDE pools — top-20 chunks against the supporting-hypothetical plus top-20 against the contradicting-hypothetical, then each chunk is assigned to the bucket whose HyDE-vector it scored higher against. Because the retrieval pool is symmetric and the classification mirrors the retrieval direction, supporting/contradicting counts come out approximately balanced regardless of the actual distribution of evidence in the corpus (a topic that is 90% supported in the literature will still show a ~1:1 split here). Use fast mode for 'is there evidence on either side?', not for 'how is the field actually split?'. May also misclassify chunks that mention the topic but logically point the other way (e.g. a paper explaining 'BN is bad in transformers' may land in the contradicting bucket for an 'LN > BN' claim). 'deep' (~10s): adds an independent per-chunk LLM NLI classification on top of the union pool, so counts reflect actual semantic distribution and can be arbitrarily asymmetric. Use 'deep' whenever classification accuracy or distribution shape matters — including controversy mapping and any analysis that interprets the supporting/contradicting ratio as a signal about the field.",
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
     try {
      // Step 1: HyDE — generate hypothetical supporting + contradicting paragraphs.
      // generateHydeText is fail-safe: returns the claim itself on any error or
      // unusably short LLM output. Will never throw.
      const [supportingHypo, contradictingHypo] = await Promise.all([
        timed('hyde_supporting', () => generateHydeText(ctx, claim, 'supporting')),
        timed('hyde_contradicting', () => generateHydeText(ctx, claim, 'contradicting')),
      ]);

      // Step 2: embed all 3 (claim + 2 hypotheticals). Wrapped in retry — Gemini
      // embedding API has transient rate-limit / timeout failures under load.
      // If retries exhaust we surface a structured error instead of 500.
      let claimEmbed: { vector: number[]; vectorName: string };
      let supEmbed: { vector: number[]; vectorName: string };
      let conEmbed: { vector: number[]; vectorName: string };
      try {
        [claimEmbed, supEmbed, conEmbed] = await timed('embed', () => Promise.all([
          retry(() => embedQuery(claim, 'gemini', ctx), 'find_evidence/embed-claim'),
          retry(() => embedQuery(supportingHypo, 'gemini', ctx), 'find_evidence/embed-sup'),
          retry(() => embedQuery(contradictingHypo, 'gemini', ctx), 'find_evidence/embed-con'),
        ]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[find_evidence] embedding stage failed after retries:', message);
        return jsonResult(buildErrorResponse({
          claim,
          mode,
          errorCode: 'embedding_failed',
          errorMessage:
            'Could not embed claim or HyDE outputs after retries. The embedding service may be overloaded or the claim may have triggered a content filter. Try again in a few seconds.',
          stage: 'embed',
        }));
      }

      // Step 3: vector search for each (top 20 each). Qdrant search is local-network
      // and rarely transient; wrap in retry as cheap insurance.
      const POOL = 20;
      let claimResults, supResults, conResults;
      try {
        [claimResults, supResults, conResults] = await timed('vector_search', () => Promise.all([
          retry(() => ctx.vectorStore.search(claimEmbed.vector, claimEmbed.vectorName, POOL), 'find_evidence/vsearch-claim'),
          retry(() => ctx.vectorStore.search(supEmbed.vector, supEmbed.vectorName, POOL), 'find_evidence/vsearch-sup'),
          retry(() => ctx.vectorStore.search(conEmbed.vector, conEmbed.vectorName, POOL), 'find_evidence/vsearch-con'),
        ]));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[find_evidence] vector-search stage failed after retries:', message);
        return jsonResult(buildErrorResponse({
          claim,
          mode,
          errorCode: 'vector_search_failed',
          errorMessage:
            'Could not search the corpus after retries. The vector store may be temporarily unreachable. Try again in a few seconds.',
          stage: 'vector_search',
        }));
      }

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
      chunks = await timed('hydrate', () => hydrateChunkContexts(chunks, ctx));

      // Step 5: doc filter
      const docIds = [...new Set(chunks.map((c) => c.documentId))];
      const docs = await timed('fetch_docs', () => fetchDocuments(docIds, ctx));
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
        // LLM NLI classification — slow but more accurate. Per-chunk failures
        // already fall back to neutral inside classifyByNLI; we add the same
        // outer try/catch as defensive depth in case a future change removes
        // the inner fallback.
        classified = await timed('classify_nli', () => Promise.all(chunks.map(async (c) => {
          try {
            const { relation, confidence } = await classifyByNLI(ctx, claim, c.content);
            return { ...c, relation, confidence };
          } catch (err) {
            console.error('[find_evidence] NLI classify exception leaked, defaulting neutral:', err instanceof Error ? err.message : err);
            return { ...c, relation: 'neutral' as Relation, confidence: 0.3 };
          }
        })));
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
              contentType: c.context.contentType ?? 'unknown',
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
        ...(mode === 'fast' ? {
          methodologyNote:
            "Fast-mode counts are approximately symmetric by construction (retrieval uses a balanced supporting+contradicting HyDE pool, classification mirrors retrieval direction). Do NOT interpret the supporting/contradicting ratio as a signal about the actual distribution of evidence in the corpus. Re-run with mode='deep' for a distribution that reflects true literature balance.",
        } : {}),
        summary: {
          supporting: groups.supporting.length,
          contradicting: groups.contradicting.length,
          neutral: groups.neutral.length,
        },
        supporting: formatGroup(groups.supporting),
        contradicting: formatGroup(groups.contradicting),
        neutral: formatGroup(groups.neutral),
      });
     } catch (err) {
       // Final safety net: any uncaught exception from any stage is converted
       // to a structured 200 response so clients never see HTTP 500 from
       // find_evidence. The error is logged for server-side debugging.
       const message = err instanceof Error ? err.message : String(err);
       const stack = err instanceof Error ? err.stack : undefined;
       console.error('[find_evidence] uncaught exception:', message, stack);
       return jsonResult(buildErrorResponse({
         claim,
         mode,
         errorCode: 'internal_error',
         errorMessage:
           'Internal error processing claim. The error has been logged. If reproducible, please report the exact claim text.',
         stage: 'unknown',
       }));
     }
    },
  );
}

/**
 * Build a structured empty response used when a stage fails after retries.
 * Returned to clients with HTTP 200 + JSON-RPC result envelope, so the call
 * never surfaces as 500. Clients can branch on the `error` field.
 */
function buildErrorResponse(args: {
  claim: string;
  mode: 'fast' | 'deep';
  errorCode: string;
  errorMessage: string;
  stage: string;
}): Record<string, unknown> {
  return {
    claim: args.claim,
    mode: args.mode,
    error: args.errorCode,
    errorMessage: args.errorMessage,
    errorStage: args.stage,
    summary: { supporting: 0, contradicting: 0, neutral: 0 },
    supporting: [],
    contradicting: [],
    neutral: [],
  };
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
    const resp = await retry(
      () => ctx.modelRouter.complete('enrichment', prompt, {
        maxTokens: 250,
        temperature: 0.4,
      }),
      `find_evidence/hyde-${direction}`,
    );
    recordLlm(resp, 'enrichment');
    const text = resp.text.trim();
    // The LLM may return an unusably short response when it refuses the prompt,
    // hits a content filter, or returns only hedging text that gets stripped.
    // Such output ("", "I cannot...", a single token) makes a poor embedding
    // input — fall back to the claim itself to preserve downstream behavior.
    if (text.length < HYDE_MIN_USABLE_CHARS) {
      console.warn(
        `[find_evidence] HyDE ${direction} returned ${text.length}-char output (below ${HYDE_MIN_USABLE_CHARS}-char threshold); falling back to claim`,
      );
      return claim;
    }
    return text;
  } catch (err) {
    // Fallback: use the claim itself as approximation. retry already exhausted
    // attempts, so this is a hard failure from the model provider.
    console.error(`[find_evidence] HyDE ${direction} failed after retries:`, err instanceof Error ? err.message : err);
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
    const resp = await retry(
      () => ctx.modelRouter.complete('enrichment', prompt, {
        maxTokens: 60,
        temperature: 0.0,
      }),
      'find_evidence/nli',
      // NLI runs in parallel for each chunk; aggressive retries here would
      // multiply load. Keep modest: 2 attempts with short backoff.
      { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2000 },
    );
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
    console.error('[find_evidence] NLI classify failed after retries:', err instanceof Error ? err.message : err);
    return { relation: 'neutral', confidence: 0.3 };
  }
}
