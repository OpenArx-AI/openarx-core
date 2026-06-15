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
 *   3. Resolve the cited-doc set (DOI + arXiv + OpenArx oarx_id) from structured
 *      references AND document body text (0skd) — needed by 5/6/7 below.
 *   4. Aggregate per document_id: max similarity, matched section count.
 *   5. novelty = median(1 - max_sim_per_chunk), EXCLUDING cited neighbours
 *      (szpw): credited prior work is not a novelty penalty.
 *   6. similar_documents JSONB: top-10 by max_sim desc (T_overlap=0.75), each
 *      with is_cited, and is_near_duplicate = (max_sim > T_dup=0.90) AND NOT
 *      is_cited (szpw — a cited source is never a plagiarism signal).
 *   7. grounding = |cited ∩ similar| / |similar|; NULL if |similar|=0 or nothing
 *      cited (never a misleading 0) (0skd).
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
 *  neighbours returned) → max_sim=0 → contributes 1.0 to median.
 *
 *  Cited neighbours are EXCLUDED from the per-chunk max (openarx-contracts-szpw):
 *  proximity to prior work the author explicitly credits is the legitimate
 *  result of building on it, not low novelty. A chunk whose only matches are
 *  cited sources contributes full novelty (1.0). citedDocIds defaults empty,
 *  preserving the pre-szpw behaviour for callers that don't pass it. */
export function computeNovelty(
  batchResults: SearchResult[][],
  citedDocIds: Set<string> = new Set(),
): number {
  if (batchResults.length === 0) return 1.0;
  const perChunk = batchResults.map((results) => {
    const nonCited = citedDocIds.size > 0
      ? results.filter((r) => !citedDocIds.has(r.documentId))
      : results;
    if (nonCited.length === 0) return 1.0;
    const maxSim = Math.max(...nonCited.map((r) => r.score));
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
  /** True iff this neighbour is in the document's cited set (openarx-contracts-szpw).
   *  A cited source is never flagged as a near-duplicate — explicit credit is the
   *  legitimate justification for high overlap. */
  is_cited: boolean;
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
  citedDocIds: Set<string> = new Set(),
): SimilarDocumentEntry[] {
  const filtered = [...agg.values()].filter((x) => x.maxSim >= tOverlap);
  filtered.sort((a, b) => b.maxSim - a.maxSim);
  return filtered.slice(0, topN).map((x) => {
    const meta = metadata.get(x.documentId);
    const isCited = citedDocIds.has(x.documentId);
    return {
      document_id: x.documentId,
      title: meta?.title ?? null,
      authors: meta?.authors ?? null,
      similarity: Number(x.maxSim.toFixed(4)),
      matched_section_count: x.matchedSectionCount,
      // is_near_duplicate = (similarity > T_dup) AND NOT cited (szpw): a cited
      // source can't be a plagiarism signal. Raw similarity stays above.
      is_near_duplicate: x.isNearDuplicate && !isCited,
      is_cited: isCited,
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

/**
 * Extract DOI + arXiv identifiers from free-form document text — markdown
 * reference lists (numbered `[N]`, footnote, plain paragraph) or inline body
 * citations (openarx-contracts-0skd). Complements extractCitedIdentifiers,
 * which only sees GROBID-structured references (empty for markdown docs).
 *
 * Recognizes: arXiv URL (arxiv.org/abs|pdf/ID), bare arXiv (arxiv:ID),
 * doi.org URL, `DOI:`/`doi:` prefix, bare DOIs, and OpenArx-native ids
 * (`oarx-` + 16 hex, or legacy 8 hex) — the platform's own papers frequently
 * have no DOI/arXiv and are cited only by oarx_id, and there is currently no
 * public document URL scheme (openarx-contracts-0skd). Normalizes arXiv IDs
 * (version suffix `vN` stripped), DOIs (lowercase `10.xxxx/...`) and oarx_ids
 * (lowercase); deduplicates.
 */
export function extractIdentifiersFromText(text: string): { dois: string[]; arxivIds: string[]; oarxIds: string[] } {
  const dois = new Set<string>();
  const arxivIds = new Set<string>();
  const oarxIds = new Set<string>();
  if (!text) return { dois: [], arxivIds: [], oarxIds: [] };

  // arXiv new-style YYMM.NNNNN via abs/pdf URL or arxiv:/arXiv: prefix.
  for (const m of text.matchAll(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)(\d{4}\.\d{4,5})(?:v\d+)?/gi)) {
    arxivIds.add(m[1].toLowerCase());
  }
  // arXiv old-style (e.g. cs.LG/0405001) via URL — best effort.
  for (const m of text.matchAll(/arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/gi)) {
    arxivIds.add(m[1].toLowerCase());
  }
  // DOI 10.XXXX/suffix anywhere — covers bare DOI, `DOI:` prefix and doi.org URL.
  for (const m of text.matchAll(/\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/gi)) {
    // The greedy class can swallow trailing sentence punctuation — trim it.
    const doi = m[1].replace(/[.,;:)\]]+$/, '').toLowerCase();
    if (doi.includes('/')) dois.add(doi);
  }
  // OpenArx-native id: oarx- + 16 hex (new) or 8 hex (legacy). Matches a bare
  // oarx_id or one embedded in a URL; the \b after rejects wrong-length blobs.
  for (const m of text.matchAll(/\boarx-([0-9a-f]{16}|[0-9a-f]{8})\b/gi)) {
    oarxIds.add(`oarx-${m[1].toLowerCase()}`);
  }

  return { dois: [...dois], arxivIds: [...arxivIds], oarxIds: [...oarxIds] };
}

/**
 * Heuristic: does the document visibly carry a references/bibliography section?
 * (openarx-contracts-0skd). True when a `References`/`Bibliography`/`Works Cited`
 * heading line is present, or there are ≥3 numbered reference lines (`[N] …`).
 * Used to keep grounding NULL (not 0) when extraction finds nothing but the
 * author clearly DID cite (e.g. title-only citations the parser can't resolve).
 */
export function hasReferencesSection(text: string): boolean {
  if (!text) return false;
  if (/^[#>\s]*(?:references|bibliography|works\s+cited)\s*:?\s*$/im.test(text)) return true;
  const numbered = text.match(/^\s*\[\d{1,4}\]\s+\S/gm);
  return (numbered?.length ?? 0) >= 3;
}

/**
 * Aspect-3 grounding decision with the openarx-contracts-0skd NULL semantics.
 *
 *  - |similar| = 0                  → NULL (cannot compute; pre-existing).
 *  - no cited identifiers extracted → NULL, NEVER 0. A bare `0` falsely reads
 *    as "the author cited nothing relevant"; NULL reads as "cannot compute".
 *    hasReferencesSection only labels the reason — refs visible means the
 *    parser likely missed title-only citations (contract-deferred MVP
 *    false-negative); no refs means a novel domain with nothing to cite.
 *  - cited identifiers present      → |cited ∩ similar| / |similar|. Here 0.0
 *    is legitimate: the author cited prior work, none of it overlapping the
 *    corpus-similar set.
 */
export function resolveGroundingScore(params: {
  hasCitedIdentifiers: boolean;
  hasReferencesSection: boolean;
  citedDocIds: Set<string>;
  similarDocIds: Set<string>;
}): { score: number | null; reason: string } {
  if (params.similarDocIds.size === 0) return { score: null, reason: 'no_similar_docs' };
  if (!params.hasCitedIdentifiers) {
    return params.hasReferencesSection
      ? { score: null, reason: 'references_present_but_unparsed' }
      : { score: null, reason: 'no_references_section' };
  }
  return { score: computeGrounding(params.citedDocIds, params.similarDocIds), reason: 'computed' };
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
  /** Concatenated document body text (chunk content), scanned for DOI/arXiv
   *  identifiers and the references-section heuristic — covers markdown docs
   *  whose references never reach GROBID-structured `references`
   *  (openarx-contracts-0skd). */
  bodyText: string;
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

  // 3. Resolve cited docs FIRST — needed to exclude cited neighbours from
  //    novelty AND to set is_cited / gate is_near_duplicate on similar_documents
  //    (openarx-contracts-szpw, sharing 0skd's cited resolution). Identifiers
  //    come from the GROBID-structured references (LaTeX/PDF), the document body
  //    text (markdown ref lists / inline citations) AND the raw reference
  //    strings — unioned. OpenArx-native citations (oarx_id) count too: the
  //    platform's own papers often have no DOI/arXiv.
  const refsText = input.references
    .map((r) => `${r.raw ?? ''} ${r.url ?? ''} ${r.doi ?? ''}`)
    .join('\n');
  const fromStructured = extractCitedIdentifiers(input.references);
  const fromText = extractIdentifiersFromText(`${input.bodyText}\n${refsText}`);
  const dois = [...new Set([...fromStructured.dois, ...fromText.dois])];
  const arxivIds = [...new Set([...fromStructured.arxivIds, ...fromText.arxivIds])];
  const oarxIds = fromText.oarxIds;
  const hasCitedIdentifiers = dois.length > 0 || arxivIds.length > 0 || oarxIds.length > 0;

  const citedDocIds = new Set<string>();
  if (hasCitedIdentifiers) {
    // oarx_id match covers full new-format ids; left(oarx_id,13) covers a
    // legacy-form (oarx- + 8 hex) citation against the stored 21-char id.
    const { rows } = await pgQuery<{ id: string }>(
      `SELECT id::text AS id FROM documents
       WHERE (external_ids->>'doi') = ANY($1::text[])
          OR source_id = ANY($2::text[])
          OR (external_ids->>'arxiv_id') = ANY($2::text[])
          OR oarx_id = ANY($3::text[])
          OR left(oarx_id, 13) = ANY($3::text[])`,
      [dois, arxivIds, oarxIds],
    );
    for (const r of rows) citedDocIds.add(r.id);
  }

  // 4. Aggregate neighbours; novelty EXCLUDES cited sources (szpw) — revisiting
  //    work the author explicitly credits is legitimate, not low novelty.
  const agg = aggregateSimilarDocs(batchResults, T_DUP);
  const noveltyScore = computeNovelty(batchResults, citedDocIds);

  // 5. Fetch metadata for all neighbour docs (title + authors for UI)
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

  // 6. Build similar_documents JSONB: is_cited per neighbour + is_near_duplicate
  //    gated by it (a cited source is never a plagiarism signal — szpw).
  const similarDocuments = buildSimilarDocuments(agg, metadata, T_OVERLAP, TOP_N_SIMILAR, citedDocIds);

  // 7. Grounding with 0skd NULL semantics: never report 0 when nothing was
  //    cited (that falsely reads as "cited nothing relevant"); 0.0 is reserved
  //    for the case where the author DID cite parseable work that simply does
  //    not overlap the corpus-similar set.
  const similarSetForGrounding = new Set(
    [...agg.values()].filter((x) => x.maxSim >= T_OVERLAP).map((x) => x.documentId),
  );
  const referencesPresent = hasReferencesSection(input.bodyText);
  const { score: groundingScore, reason: groundingReason } = resolveGroundingScore({
    hasCitedIdentifiers,
    hasReferencesSection: referencesPresent,
    citedDocIds,
    similarDocIds: similarSetForGrounding,
  });

  logger.info('novelty: aspect 3 complete', {
    documentId: input.documentId,
    samples: samples.length,
    neighbours: neighbourIds.length,
    similar_over_t_overlap: similarSetForGrounding.size,
    cited_identifiers: dois.length + arxivIds.length + oarxIds.length,
    cited_resolved: citedDocIds.size,
    references_present: referencesPresent,
    grounding_reason: groundingReason,
    noveltyScore,
    groundingScore,
  });

  return {
    noveltyScore,
    groundingScore,
    similarDocuments,
  };
}
