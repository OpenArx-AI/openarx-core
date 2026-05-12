/**
 * Aspect 3 — Novelty + Grounding worker.
 *
 * Contract: contracts/content_review.md §3 Aspect 3.
 *
 * Inputs per document:
 *   - chunks (post-embed, with gemini vectors available)
 *   - concept_id (to exclude self-version matches via must_not filter)
 *   - parsed references (for grounding resolution)
 *
 * Pipeline:
 *   1. Stride-sample up to 100 chunks deterministically
 *   2. Single batched Qdrant query across samples, K=5 neighbours each,
 *      must_not: { concept_id = self }
 *   3. Aggregate per document_id: max similarity, matched section count,
 *      is_near_duplicate (max_sim > T_dup=0.90)
 *   4. Filter to T_overlap=0.75 for the "similar" set used by grounding
 *   5. Compute novelty = median(1 - max_sim_per_chunk)
 *   6. Resolve cited documents (DOI + arxiv URL only, per contract) from
 *      parsed references; intersect with similar-doc set.
 *   7. grounding = |cited ∩ similar| / |similar|, or NULL if |similar|=0.
 *   8. similar_documents JSONB: top-10 by max_sim desc.
 *
 * Deterministic — no LLM in Phase 2. Failures are non-blocking: caller
 * writes status='complete' with NULL aspect 3 fields.
 */

import type { ParsedReference, SearchResult, VectorStore } from '@openarx/types';

// Constants from contract §3
export const K_NEIGHBOURS = 5;
export const T_DUP = 0.90;
export const T_OVERLAP = 0.75;
export const SAMPLE_CAP = 100;
export const TOP_N_SIMILAR = 10;

// ─── Pure functions ───────────────────────────────────────────

/** Deterministic stride sampling. When items.length <= cap, returns all
 *  items. Otherwise stride = ceil(items.length / cap), picks indices 0,
 *  stride, 2*stride, …  Returns at most `cap` items. */
export function strideSample<T>(items: T[], cap: number = SAMPLE_CAP): T[] {
  if (items.length <= cap) return items.slice();
  const stride = Math.ceil(items.length / cap);
  const out: T[] = [];
  for (let i = 0; i < items.length && out.length < cap; i += stride) {
    out.push(items[i]);
  }
  return out;
}

/** Median of a non-empty array of numbers. Returns 0 for empty array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Aspect 3 novelty score: median(1 - max_similarity_per_chunk) over
 *  the batch of sample queries. Empty batches → 1.0 (nothing to match
 *  against means maximally novel). Per-query empty results (no
 *  neighbours returned) → max_sim=0 → contributes 1.0 to median. */
export function computeNovelty(batchResults: SearchResult[][]): number {
  if (batchResults.length === 0) return 1.0;
  const perChunk = batchResults.map((results) => {
    if (results.length === 0) return 1.0;
    const maxSim = Math.max(...results.map((r) => r.score));
    return 1 - maxSim;
  });
  return median(perChunk);
}

/** Single entry in a per-document aggregation: the highest similarity
 *  any sample chunk hit against this document, and how many sample
 *  chunks had at least one match in this document. */
export interface SimilarDocAgg {
  documentId: string;
  maxSim: number;
  matchedSectionCount: number;
  isNearDuplicate: boolean;
}

/** Aggregate batch search results into one record per neighbour document.
 *  Self-document is already excluded by the must_not concept_id filter
 *  upstream; this function never filters by concept itself. */
export function aggregateSimilarDocs(
  batchResults: SearchResult[][],
  tDup: number = T_DUP,
): Map<string, SimilarDocAgg> {
  const byDoc = new Map<string, SimilarDocAgg>();
  for (const results of batchResults) {
    // Track which docs were matched by this sample — one chunk can produce
    // multiple neighbours in the same doc, but we count this chunk as
    // "matching" the doc only once.
    const seenThisSample = new Set<string>();
    for (const r of results) {
      if (seenThisSample.has(r.documentId)) {
        // Already counted for this sample; still update maxSim.
        const cur = byDoc.get(r.documentId);
        if (cur && r.score > cur.maxSim) {
          cur.maxSim = r.score;
          cur.isNearDuplicate = r.score > tDup;
        }
        continue;
      }
      seenThisSample.add(r.documentId);
      const existing = byDoc.get(r.documentId);
      if (!existing) {
        byDoc.set(r.documentId, {
          documentId: r.documentId,
          maxSim: r.score,
          matchedSectionCount: 1,
          isNearDuplicate: r.score > tDup,
        });
      } else {
        existing.matchedSectionCount += 1;
        if (r.score > existing.maxSim) {
          existing.maxSim = r.score;
          existing.isNearDuplicate = r.score > tDup;
        }
      }
    }
  }
  return byDoc;
}

/** Shape of one entry in the stored similar_documents JSONB array
 *  (contract §4 data model). */
export interface SimilarDocumentEntry {
  document_id: string;
  title: string | null;
  authors: string[] | null;
  similarity: number;
  matched_section_count: number;
  is_near_duplicate: boolean;
}

/** Build the top-N similar_documents JSONB array.
 *  - Filters out entries below T_overlap (these are not structurally
 *    "similar enough" to count toward grounding either, but the shape
 *    here is the UI-facing one; grounding uses its own filtered set).
 *  - Sorts by maxSim descending, takes top N.
 *  - title/authors enrichment comes from a caller-supplied metadata map
 *    keyed by document_id. */
export function buildSimilarDocuments(
  agg: Map<string, SimilarDocAgg>,
  metadata: Map<string, { title: string | null; authors: string[] | null }>,
  tOverlap: number = T_OVERLAP,
  topN: number = TOP_N_SIMILAR,
): SimilarDocumentEntry[] {
  const filtered = [...agg.values()].filter((x) => x.maxSim >= tOverlap);
  filtered.sort((a, b) => b.maxSim - a.maxSim);
  return filtered.slice(0, topN).map((x) => {
    const meta = metadata.get(x.documentId);
    return {
      document_id: x.documentId,
      title: meta?.title ?? null,
      authors: meta?.authors ?? null,
      similarity: Number(x.maxSim.toFixed(4)),
      matched_section_count: x.matchedSectionCount,
      is_near_duplicate: x.isNearDuplicate,
    };
  });
}

/** Grounding score = |cited ∩ similar| / |similar|. Returns null when
 *  similar set is empty (division undefined, also uninformative). */
export function computeGrounding(
  citedDocIds: Set<string>,
  similarDocIds: Set<string>,
): number | null {
  if (similarDocIds.size === 0) return null;
  let hits = 0;
  for (const sid of similarDocIds) {
    if (citedDocIds.has(sid)) hits += 1;
  }
  return hits / similarDocIds.size;
}

/** Extract DOI + arxiv-ID candidates from parsed references.
 *  Contract §3: cited resolution is DOI-match + arxiv URL-match only.
 *  Returns lowercased DOIs and arxiv IDs (canonicalised for comparison). */
export function extractCitedIdentifiers(
  references: ParsedReference[],
): { dois: string[]; arxivIds: string[] } {
  const dois: string[] = [];
  const arxivIds: string[] = [];
  for (const ref of references) {
    if (ref.doi) {
      dois.push(ref.doi.trim().toLowerCase());
    }
    // arxiv URL pattern: arxiv.org/abs/YYMM.NNNNN or abs/cs.LG/0405001 etc.
    const url = ref.url ?? ref.raw ?? '';
    const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([a-zA-Z\-.]+\/)?(\d{4}\.\d{4,5}|[a-zA-Z\-.]+\/\d{7})/i);
    if (match) {
      const id = (match[1] ?? '') + match[2];
      arxivIds.push(id.replace(/^\//, '').toLowerCase());
    }
  }
  return { dois: [...new Set(dois)], arxivIds: [...new Set(arxivIds)] };
}

// ─── Orchestration (impure — reads Qdrant + PG) ───────────────

export interface NoveltyWorkerDeps {
  vectorStore: VectorStore;
  /** Query helper used for cited-resolution + metadata fetch. Signature
   *  matches pg.Pool.query for a single statement with positional params. */
  pgQuery: <T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: T[] }>;
  logger: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
}

export interface NoveltyWorkerInput {
  documentId: string;
  conceptId: string;
  chunks: Array<{ vectors: { gemini?: number[] } }>;
  references: ParsedReference[];
}

export interface NoveltyWorkerOutput {
  noveltyScore: number | null;
  groundingScore: number | null;
  similarDocuments: SimilarDocumentEntry[] | null;
}

/** End-to-end Aspect 3 computation. Caller wraps in try/catch and calls
 *  updateAspect3Fields (with NULLs on failure). */
export async function runNoveltyWorker(
  input: NoveltyWorkerInput,
  deps: NoveltyWorkerDeps,
): Promise<NoveltyWorkerOutput> {
  const { vectorStore, pgQuery, logger } = deps;

  // 1. Sample chunks with gemini vectors present
  const chunksWithVector = input.chunks.filter((c) => Array.isArray(c.vectors.gemini) && c.vectors.gemini.length > 0);
  if (chunksWithVector.length === 0) {
    logger.warn('novelty: no chunks with gemini vectors, skipping', { documentId: input.documentId });
    return { noveltyScore: null, groundingScore: null, similarDocuments: null };
  }
  const samples = strideSample(chunksWithVector, SAMPLE_CAP);

  // 2. Batched Qdrant search with self-concept exclusion
  const batchResults = await vectorStore.batchSearch(
    samples.map((c) => ({
      vector: c.vectors.gemini!,
      vectorName: 'gemini',
      filter: { must_not: [{ key: 'concept_id', match: { value: input.conceptId } }] },
      limit: K_NEIGHBOURS,
    })),
  );

  // 3. Aggregate + compute novelty
  const agg = aggregateSimilarDocs(batchResults, T_DUP);
  const noveltyScore = computeNovelty(batchResults);

  // 4. Fetch metadata for all neighbour docs (title + authors for UI)
  const neighbourIds = [...agg.keys()];
  const metadata = new Map<string, { title: string | null; authors: string[] | null }>();
  if (neighbourIds.length > 0) {
    const { rows } = await pgQuery<{ id: string; title: string | null; authors: string[] | null }>(
      `SELECT id::text AS id, title, authors FROM documents WHERE id = ANY($1::uuid[])`,
      [neighbourIds],
    );
    for (const r of rows) {
      metadata.set(r.id, { title: r.title, authors: r.authors });
    }
  }

  // 5. Build similar_documents JSONB (filtered to T_overlap, top 10)
  const similarDocuments = buildSimilarDocuments(agg, metadata, T_OVERLAP, TOP_N_SIMILAR);

  // 6. Resolve cited docs from refs (DOI + arxiv URL) → doc_ids
  const { dois, arxivIds } = extractCitedIdentifiers(input.references);
  const citedDocIds = new Set<string>();
  if (dois.length > 0 || arxivIds.length > 0) {
    const { rows } = await pgQuery<{ id: string }>(
      `SELECT id::text AS id FROM documents
       WHERE (external_ids->>'doi') = ANY($1::text[])
          OR source_id = ANY($2::text[])
          OR (external_ids->>'arxiv_id') = ANY($2::text[])`,
      [dois, arxivIds],
    );
    for (const r of rows) citedDocIds.add(r.id);
  }

  // 7. Similar set for grounding = same T_overlap filter as similar_documents
  const similarSetForGrounding = new Set(
    [...agg.values()].filter((x) => x.maxSim >= T_OVERLAP).map((x) => x.documentId),
  );
  const groundingScore = computeGrounding(citedDocIds, similarSetForGrounding);

  logger.info('novelty: aspect 3 complete', {
    documentId: input.documentId,
    samples: samples.length,
    neighbours: neighbourIds.length,
    similar_over_t_overlap: similarSetForGrounding.size,
    cited_resolved: citedDocIds.size,
    noveltyScore,
    groundingScore,
  });

  return {
    noveltyScore,
    groundingScore,
    similarDocuments,
  };
}
