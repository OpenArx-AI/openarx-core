/**
 * Pipeline route definitions — steps each document type follows.
 *
 * A route is an ordered list of steps. Each step declares which
 * resource pool slot it needs. The orchestrator acquires the resource
 * before executing the step and releases it after.
 *
 * Splitting embed into gemini + specter2 allows them to use separate
 * resource pools (specter2 is GPU-bound with capacity=1).
 */

/** A single step in a document's pipeline route. */
export interface RouteStep {
  /** Human-readable step name (for logging / status). */
  name: string;
  /** Resource pool key to acquire before executing. */
  resource: string;
  /** Worker key — maps to a function in workers.ts. */
  worker: string;
}

/** Route for LaTeX-sourced documents. */
export const LATEX_ROUTE: RouteStep[] = [
  { name: 'parse',          resource: 'latex_parse',    worker: 'parse' },
  { name: 'translate',      resource: 'llm_chunking',   worker: 'translate' },
  { name: 'chunk',          resource: 'llm_chunking',   worker: 'chunk' },
  { name: 'enrich',         resource: 'llm_chunking',   worker: 'enrich' },
  { name: 'embed_gemini',   resource: 'gemini_embed',   worker: 'embed_gemini' },
  { name: 'embed_specter',  resource: 'specter2_embed', worker: 'embed_specter' },
  { name: 'index',          resource: 'qdrant_write',   worker: 'index' },
  // Aspect 3 (content-review novelty + grounding). No-ops for non-Portal docs.
  // Shares qdrant_write pool — read-only but same backend.
  { name: 'review_novelty', resource: 'qdrant_write',   worker: 'review_novelty' },
  { name: 's2_lookup',      resource: 's2_lookup',      worker: 's2_lookup' },
];

/** Route for PDF-sourced documents (GROBID/Docling). */
export const PDF_ROUTE: RouteStep[] = [
  { name: 'parse',          resource: 'grobid_parse',   worker: 'parse' },
  { name: 'translate',      resource: 'llm_chunking',   worker: 'translate' },
  { name: 'chunk',          resource: 'llm_chunking',   worker: 'chunk' },
  { name: 'enrich',         resource: 'llm_chunking',   worker: 'enrich' },
  { name: 'embed_gemini',   resource: 'gemini_embed',   worker: 'embed_gemini' },
  { name: 'embed_specter',  resource: 'specter2_embed', worker: 'embed_specter' },
  { name: 'index',          resource: 'qdrant_write',   worker: 'index' },
  { name: 'review_novelty', resource: 'qdrant_write',   worker: 'review_novelty' },
  { name: 's2_lookup',      resource: 's2_lookup',      worker: 's2_lookup' },
];

/**
 * Lightweight route for documents under restricted licenses (no full-text indexing).
 *
 * Skips parse + chunking — instead creates a single chunk from the document's
 * abstract (which is metadata, not file content). Still embeds via Gemini +
 * SPECTER2 and runs enrichment for code/dataset/benchmark links discovered
 * via abstract text or external sources (PwC, Semantic Scholar).
 *
 * Cost: ~100x cheaper than full pipeline (no LLM chunking, single embedding pair).
 * Indexed documents remain searchable by abstract; only file delivery is gated
 * by the policy layer.
 */
export const ABSTRACT_ONLY_ROUTE: RouteStep[] = [
  { name: 'abstract_chunk', resource: 'llm_chunking',   worker: 'abstract_chunk' },
  { name: 'enrich',         resource: 'llm_chunking',   worker: 'enrich' },
  { name: 'embed_gemini',   resource: 'gemini_embed',   worker: 'embed_gemini' },
  { name: 'embed_specter',  resource: 'specter2_embed', worker: 'embed_specter' },
  { name: 'index',          resource: 'qdrant_write',   worker: 'index' },
  { name: 's2_lookup',      resource: 's2_lookup',      worker: 's2_lookup' },
];

/** Select route based on indexing tier and source format. */
export function selectRoute(
  sourceFormat: string | undefined,
  indexingTier?: 'full' | 'abstract_only',
): RouteStep[] {
  if (indexingTier === 'abstract_only') return ABSTRACT_ONLY_ROUTE;
  // Markdown shares the LaTeX route — same DAG (parse → translate →
  // chunk → enrich → embed → index → review_novelty → s2_lookup).
  // The only difference is the parse step's strategy, which is picked
  // up by selectStrategy() at runtime. The 'latex_parse' resource pool
  // semantically covers any non-PDF parse work; throughput is fine
  // because Markdown parsing is regex-only (no external service call).
  if (sourceFormat === 'pdf') return PDF_ROUTE;
  return LATEX_ROUTE;
}
