/**
 * ChunkerStep — ParsedDocument → Chunk[].
 *
 * Abstract → single chunk (skip LLM).
 * Remaining sections grouped into batches (~4000 chars) to minimize LLM calls.
 * LLM returns JSON array of {section, text} objects.
 * Fallback: strip markdown fences → JSON.parse → paragraph splitting.
 */

import { randomUUID } from 'node:crypto';

/** Thrown when chunking is aborted due to stop signal. Doc should return to 'downloaded'. */
export class ChunkingAbortedError extends Error {
  constructor() { super('Chunking aborted (stop requested)'); this.name = 'ChunkingAbortedError'; }
}
import type {
  Chunk,
  Document,
  ModelOptions,
  ParsedDocument,
  ParsedSection,
  PipelineContext,
  PipelineStep,
} from '@openarx/types';
import { query } from '@openarx/api';
import { textSimilarity } from '../lib/dedup.js';
import { fixChunkBoundaries } from '../lib/chunk-boundary-fix.js';
// Stage-2 Part B (marker/anchor chunking): the LLM emits start/end anchors instead of full
// text; the verbatim chunk content is recovered from the source with the SAME parity-tested
// infra the qwen bulk uses. recoverFromAnchorPairs (Stage-2) + coverageCheck (0-loss gate).
import { recoverFromAnchorPairs, coverageCheck } from './verbatim-recovery.js';

export interface ChunkerStepInput {
  parsed: ParsedDocument;
  document: Document;
}

interface ChunkJson {
  section: string;
  text: string;
  summary?: string;
  key_concept?: string;
  content_type?: string;
  entities?: string[];
  self_contained?: boolean;
}

/** Marker (anchor) chunker output — Stage-2 Part B. The LLM returns per chunk the verbatim
 *  first/last ~8 words (start_anchor/end_anchor) instead of the full text; the content is then
 *  recovered from the source. All other fields match ChunkJson. Anchors are ephemeral (consumed
 *  by recovery, never persisted). */
interface AnchorChunkJson {
  section: string;
  start_anchor: string;
  end_anchor: string;
  summary?: string;
  key_concept?: string;
  content_type?: string;
  entities?: string[];
  self_contained?: boolean;
}

/** Marker-mode WIRE keys. The model is asked for these short names instead of the internal ones,
 *  because the key names repeat on EVERY chunk and carry no information: measured at ~23 of the 168
 *  output tokens per chunk on the 2026-07-26 run, which made them the cheapest real saving available.
 *
 *  ★ This is a WIRE format only. The internal AnchorChunkJson shape and the STORED chunk context keys
 *  are unchanged — buildEmbedInput, search, the cap-marking backfill and Console all read the long
 *  names, and 36M existing chunks use them. normaliseAnchorChunk() maps wire → internal.
 *
 *  ★ Short but still readable (`sa`, not `a`): the model has to know what belongs in each field, and
 *  single letters buy a couple more tokens at the cost of comprehension on a task where a
 *  misunderstood field means a failed batch and a full-text fallback — i.e. dearer, not cheaper. */
const ANCHOR_WIRE_TO_INTERNAL: Readonly<Record<string, keyof AnchorChunkJson>> = {
  sec: 'section',
  sa: 'start_anchor',
  ea: 'end_anchor',
  sum: 'summary',
  kc: 'key_concept',
  ct: 'content_type',
  ent: 'entities',
  sc: 'self_contained',
};

/** Accept a model chunk written with EITHER the short wire keys or the original long ones.
 *
 *  Tolerating both is not politeness, it is the safety property: the long names are what the model
 *  has seen for months, and a prompt drift or a stubborn response written the old way would, under
 *  strict short-only parsing, fail the batch and send it down the full-text fallback — making the run
 *  MORE expensive, which is exactly the metric this change exists to improve. Short wins on conflict. */
export function normaliseAnchorChunk(raw: unknown): Partial<AnchorChunkJson> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Long names first, so a short key present alongside overwrites it.
  for (const long of Object.values(ANCHOR_WIRE_TO_INTERNAL)) {
    if (r[long] !== undefined) out[long] = r[long];
  }
  for (const [short, long] of Object.entries(ANCHOR_WIRE_TO_INTERNAL)) {
    if (r[short] !== undefined) out[long] = r[short];
  }
  return out as Partial<AnchorChunkJson>;
}

const VALID_CONTENT_TYPES = new Set([
  'theoretical', 'methodology', 'experimental', 'results', 'survey', 'background', 'abstract', 'other',
]);

/**
 * Strip bytes/sequences that Postgres rejects in TEXT columns.
 *
 * Origin: with structured-output schema enforcement (openarx-dlv6), Gemini
 * occasionally emits NUL bytes (U+0000) and other invalid-in-PG character
 * sequences inside string fields. Prior to schema enforcement these landed
 * inside JSON that JSON.parse couldn't read, fell into paragraph-splitter
 * fallback, and never reached the database. With schema, JSON.parse succeeds
 * → the bytes propagate → PG INSERT fails with one of:
 *   - "invalid byte sequence for encoding UTF8: 0x00"
 *   - "unsupported Unicode escape sequence"
 *
 * Sanitization removes:
 *   - U+0000 NULL bytes (PG TEXT cannot store these)
 *   - Lone high-surrogates not followed by low (invalid UTF-16 in JSON)
 *   - Lone low-surrogates without preceding high
 *   - Other control chars except \t \n \r (cosmetic, not strictly required)
 */
export function sanitizeForPg(s: string): string {
  // PG rejects two distinct things; treat them with the right primitive:
  //
  //   (1) "unsupported Unicode escape sequence" — lone surrogates (D800-DFFF
  //       not in a valid pair) that can't be encoded as valid UTF-8.
  //       WHATWG's TextEncoder.encode replaces them with U+FFFD (replacement
  //       char) per spec, giving us a tested standard implementation rather
  //       than a hand-rolled char-by-char loop.
  //
  //   (2) "invalid byte sequence for encoding UTF8: 0x00" — NUL byte (U+0000).
  //       NUL is a valid Unicode codepoint, so TextEncoder won't touch it;
  //       it's just a PG TEXT column restriction. Strip explicitly.
  const validUtf8 = new TextDecoder('utf-8').decode(new TextEncoder().encode(s));
  return validUtf8.replace(/\u0000/g, '');
}

/**
 * Content-safe repair for the dominant chunker JSON failure (openarx cost fix):
 * the no-schema base call sporadically emits a SINGLE backslash before a
 * non-escape char (LaTeX `\hat`, `\Delta`, `\{`) which JSON.parse rejects with
 * "Invalid \escape", forcing an expensive gemini-3.1-pro retry. This doubles
 * ONLY the backslashes that form an invalid JSON escape, leaving valid escapes
 * (`\"` `\\` `\n` `\uXXXX`) and already-correct `\\command` untouched — it is
 * escape-pair-aware (consumes a valid `\\` as one unit).
 *
 * Crucially it PRESERVES the LaTeX: `\hat` → `\\hat` → parses to `\hat`. A
 * general JSON repairer (jsonrepair) instead DROPS the backslash → `hat`,
 * silently corrupting math — verified on the real failure corpus, which is why
 * this targeted scanner is used. Non-escape malformations (bad control chars,
 * unescaped quotes) are intentionally NOT touched and fall through to the schema
 * retry. Measured on 120 real failures: 99% repaired, 100% of escape
 * occurrences preserved.
 */
export function repairJsonEscapes(s: string): string {
  const VALID = '"\\/bfnrt'; // single-char JSON escapes (\u handled separately)
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; continue; }
    const nx = s[i + 1];
    if (nx !== undefined && VALID.includes(nx)) { out += ch + nx; i += 1; }              // valid escape — keep the pair
    else if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += ch + nx; i += 1; } // \uXXXX
    else { out += '\\\\'; }                                                               // invalid escape — escape the backslash
  }
  return out;
}

/** Parse a fence-stripped chunker response, with a content-safe escape-repair
 *  retry when the raw text fails JSON.parse. `repaired` flags which path was
 *  taken (observability). Throws if both attempts fail. */
export function parseChunkJson(cleaned: string): { parsed: unknown; repaired: boolean } {
  try { return { parsed: JSON.parse(cleaned), repaired: false }; }
  catch { return { parsed: JSON.parse(repairJsonEscapes(cleaned)), repaired: true }; }
}

function sanitizeChunkJson(c: ChunkJson): ChunkJson {
  return {
    ...c,
    section: typeof c.section === 'string' ? sanitizeForPg(c.section) : c.section,
    text: typeof c.text === 'string' ? sanitizeForPg(c.text) : c.text,
    summary: typeof c.summary === 'string' ? sanitizeForPg(c.summary) : c.summary,
    key_concept: typeof c.key_concept === 'string' ? sanitizeForPg(c.key_concept) : c.key_concept,
    content_type: typeof c.content_type === 'string' ? sanitizeForPg(c.content_type) : c.content_type,
    entities: Array.isArray(c.entities)
      ? c.entities.filter((e): e is string => typeof e === 'string').map(sanitizeForPg)
      : c.entities,
  };
}

function sanitizeMetadata(m: Partial<ExtractedMetadata> | undefined): ExtractedMetadata {
  return {
    code_urls: Array.isArray(m?.code_urls) ? m!.code_urls.filter((u): u is string => typeof u === 'string').map(sanitizeForPg) : [],
    dataset_mentions: Array.isArray(m?.dataset_mentions) ? m!.dataset_mentions.filter((d): d is string => typeof d === 'string').map(sanitizeForPg) : [],
    benchmark_mentions: Array.isArray(m?.benchmark_mentions) ? m!.benchmark_mentions.filter((b): b is string => typeof b === 'string').map(sanitizeForPg) : [],
  };
}

/**
 * Structured-output schema for the chunker LLM call (openarx-dlv6).
 *
 * Passed via ModelOptions.responseSchema with responseMimeType=application/json.
 * The Vertex AI runtime constrains the model to emit JSON matching this shape
 * and fails the request if the model cannot comply — which eliminates the
 * class of silent parse failures previously seen (Gemini returning
 * almost-valid JSON that crashed JSON.parse and fell back to paragraph
 * splitting with null meta).
 *
 * Required per-chunk fields: section, text, summary, key_concept,
 * content_type, self_contained. `entities` is intentionally NOT required
 * (legitimately empty for non-entity-bearing content).
 *
 * content_type uses an enum constraint matching VALID_CONTENT_TYPES (minus
 * 'abstract' — abstract chunks bypass this path).
 *
 * Lab experiment (2026-05-23, 70 sections × 4 prompt variants) confirmed
 * this schema lifts parse-success from ~43% (current prompt, no schema)
 * to ~90% with no quality regression and no cost increase.
 */
const CHUNKER_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['chunks'],
  properties: {
    chunks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['section', 'text', 'summary', 'key_concept', 'content_type', 'self_contained'],
        properties: {
          section: { type: 'STRING' },
          text: { type: 'STRING' },
          summary: { type: 'STRING' },
          key_concept: { type: 'STRING' },
          content_type: {
            type: 'STRING',
            enum: ['theoretical', 'methodology', 'experimental', 'results', 'survey', 'background', 'other'],
          },
          entities: { type: 'ARRAY', items: { type: 'STRING' } },
          self_contained: { type: 'BOOLEAN' },
        },
      },
    },
    metadata: {
      type: 'OBJECT',
      properties: {
        code_urls: { type: 'ARRAY', items: { type: 'STRING' } },
        dataset_mentions: { type: 'ARRAY', items: { type: 'STRING' } },
        benchmark_mentions: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  },
};

/**
 * Diagnostic logging for the null-context investigation (openarx-3me1 follow-up).
 * Gated by env var CHUNKER_DIAG_LOG=1 — off by default in production, enabled
 * during controlled small ingests. Emits one structured line per chunk
 * creation event and per LLM batch response, so we can later aggregate by
 * pathId × meta-shape and see where null context originates.
 */
const CHUNKER_DIAG_LOG = process.env.CHUNKER_DIAG_LOG === '1';

type ChunkCreationPath =
  | 'abstract-heuristic'        // chunker-step.ts createAbstractChunk path
  | 'llm-batch-success'         // line 280 — successful LLM call, chunks have meta
  | 'llm-retry-success'         // line 233 — retry with fallback model succeeded
  | 'fallback-after-retry-truncate'  // line 248 — retry also MAX_TOKENS → paragraph split
  | 'fallback-after-exception'; // line 294 — exception in LLM path → paragraph split

interface ChunkDiagCtx {
  docId: string;
  sourceId?: string;
  section: string;
  pos: number;
  contentLen: number;
  meta?: ChunkJson | null;
}

interface DiagLogger {
  info(msg: string, data?: unknown): void;
}

function diagChunkCreated(logger: DiagLogger, path: ChunkCreationPath, ctx: ChunkDiagCtx): void {
  if (!CHUNKER_DIAG_LOG) return;
  const meta = ctx.meta;
  logger.info('diag.chunk_created', {
    diag: 'chunk_created',
    path,
    docId: ctx.docId,
    sourceId: ctx.sourceId,
    section: ctx.section.slice(0, 80),
    position: ctx.pos,
    contentLen: ctx.contentLen,
    hasMeta: meta != null,
    summaryPresent: !!meta?.summary,
    keyConceptPresent: !!meta?.key_concept,
    contentTypeRaw: meta?.content_type ?? null,
    contentTypeValid: !!(meta?.content_type && VALID_CONTENT_TYPES.has(meta.content_type)),
    selfContainedPresent: typeof meta?.self_contained === 'boolean',
    entitiesCount: Array.isArray(meta?.entities) ? meta.entities.length : 0,
  });
}

function diagLlmResponse(
  logger: DiagLogger,
  sourceId: string,
  batchSize: number,
  parsedChunks: ChunkJson[],
  validatedCount: number,
): void {
  if (!CHUNKER_DIAG_LOG) return;
  const summaryCount = parsedChunks.filter(c => !!c.summary).length;
  const keyConceptCount = parsedChunks.filter(c => !!c.key_concept).length;
  const validCtCount = parsedChunks.filter(c => c.content_type && VALID_CONTENT_TYPES.has(c.content_type)).length;
  const invalidCtValues = [...new Set(parsedChunks
    .map(c => c.content_type)
    .filter((ct): ct is string => !!ct && !VALID_CONTENT_TYPES.has(ct)))];
  logger.info('diag.llm_response_parsed', {
    diag: 'llm_response_parsed',
    sourceId,
    batchSize,
    chunksReturned: parsedChunks.length,
    chunksAfterValidation: validatedCount,
    chunksWithSummary: summaryCount,
    chunksWithKeyConcept: keyConceptCount,
    chunksWithValidContentType: validCtCount,
    invalidContentTypeValues: invalidCtValues,
  });
}

/**
 * Heuristic context for abstract chunks. Abstract chunks bypass the LLM
 * enrichment step (LLM is overkill for a self-contained summary), so we
 * populate the predictable fields directly:
 *   - contentType: 'abstract'  (was undefined → null in API responses)
 *   - selfContained: true      (abstracts are standalone by design)
 *   - summary: first sentence  (cheap proxy; the abstract IS already a summary)
 *
 * keyConcept and entities require LLM and are intentionally left undefined.
 * Clients should treat absence as "not extracted" rather than "no concept".
 */
export function buildAbstractChunkContext(
  abstract: string,
  documentTitle: string,
  totalChunks: number,
): {
  documentTitle: string;
  sectionName: string;
  sectionPath: string;
  positionInDocument: number;
  totalChunks: number;
  summary: string;
  contentType: 'abstract';
  selfContained: true;
} {
  return {
    documentTitle,
    sectionName: 'Abstract',
    sectionPath: 'Abstract',
    positionInDocument: 0,
    totalChunks,
    summary: firstSentence(abstract, 250),
    contentType: 'abstract',
    selfContained: true,
  };
}

function firstSentence(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  // Pull first sentence end (. ! ?) followed by space or EOL. If the LaTeX/PDF
  // parser left no terminal punctuation, fall back to the whole text capped.
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let candidate = match ? match[0] : trimmed;
  if (candidate.length > maxChars) {
    candidate = candidate.slice(0, maxChars).trim() + '...';
  }
  return candidate;
}

interface ExtractedMetadata {
  code_urls: string[];
  dataset_mentions: string[];
  benchmark_mentions: string[];
}

interface ChunkerResponse {
  chunks: ChunkJson[];
  metadata: ExtractedMetadata;
}

const EMPTY_METADATA: ExtractedMetadata = {
  code_urls: [],
  dataset_mentions: [],
  benchmark_mentions: [],
};

interface FlatSection extends ParsedSection {
  path: string;
}

const BATCH_CHAR_LIMIT = 3500;
const DEDUP_SIMILARITY_THRESHOLD = 0.85;
const MIN_SECTION_CHARS = 30;
const MIN_CHUNK_CHARS = 50;
const MAX_NON_ALNUM_RATIO = 0.6;

export class ChunkerStep implements PipelineStep<ChunkerStepInput, Chunk[]> {
  readonly name = 'chunker';

  async process(input: ChunkerStepInput, context: PipelineContext): Promise<Chunk[]> {
    const { parsed, document } = input;
    const { modelRouter, logger, costTracker } = context;

    const chunks: Chunk[] = [];
    let position = 0;

    // Abstract → single chunk (already self-contained, skip LLM enrichment but
    // populate context fields via buildAbstractChunkContext heuristic so
    // downstream clients (search, find_evidence, get_document) see the same
    // shape as enriched body chunks instead of all-null context fields
    // (PF-003).
    if (parsed.abstract?.trim()) {
      diagChunkCreated(logger, 'abstract-heuristic', {
        docId: document.id, sourceId: document.sourceId, section: 'Abstract',
        pos: position, contentLen: parsed.abstract.length, meta: null,
      });
      chunks.push(this.createAbstractChunk(document.id, parsed.abstract, position++, ''));
      logger.debug('Abstract added as chunk (heuristic context populated)');
    }

    // Flatten sections
    const flatSections = this.flattenSections(parsed.sections);

    // Filter out empty and tiny sections (figure captions, diagram labels)
    const nonEmpty = flatSections.filter((s) => s.content.trim().length > 0);
    const substantive = nonEmpty.filter((s) => s.content.trim().length >= MIN_SECTION_CHARS);
    const filteredSections = nonEmpty.length - substantive.length;
    if (filteredSections > 0) {
      logger.debug(`Filtered ${filteredSections} tiny sections (<${MIN_SECTION_CHARS} chars)`);
    }

    if (substantive.length === 0) {
      logger.warn('No substantive sections found beyond abstract');
      this.setTotalChunks(chunks, chunks.length);
      return chunks;
    }

    // Group sections into batches with overlap
    const batches = this.groupIntoBatches(substantive);
    logger.info(`Chunking ${nonEmpty.length} sections in ${batches.length} batches`);

    // Base chunking call: NO responseSchema parameter.
    //
    // The `responseSchema` PARAMETER auto-enables Gemini-3 thinking (openarx-cmnj),
    // which on math/LaTeX-dense batches inflates output to the 65K MAX_TOKENS cap
    // (~$1.46/doc vs ~$0.06 on light docs; 60% of heavy batches truncated). The
    // schema is still fully described in the prompt (buildPrompt MUST-markers),
    // which keeps meta ~100% complete — verified on a 5-doc heavy / 8-doc light
    // experiment (2026-06-01). temperature=1 (Gemini-3 recommended) minimised
    // JSON split-failures in that test.
    //
    // The trade-off the schema PARAMETER was hiding: ~15-25% of heavy LaTeX
    // batches emit an invalid JSON escape (single backslash on a `\command`,
    // finishReason=STOP). We detect that (hasValidChunkJson) and retry the batch
    // on gemini-3.1-pro-preview WITH the schema (correct JSON serialisation of
    // LaTeX-heavy text). Backslash preservation on the no-schema path measured
    // 98.8% with zero control-char corruption, so successfully-parsed chunks are
    // safe; only the hard parse-failures pay the pro retry.
    const callerOptions = context.config.chunkerOptions as ModelOptions | undefined;
    const chunkerOptions: ModelOptions = {
      temperature: 1,
      ...(callerOptions ?? {}),
    };
    // Schema-constrained options for the correctness-retry only (pro fallback).
    const retrySchemaOptions: ModelOptions = {
      ...chunkerOptions,
      responseMimeType: 'application/json',
      responseSchema: CHUNKER_RESPONSE_SCHEMA,
    };

    // Track where each batch's chunks start in the array
    const batchBounds: number[] = [];
    const mergedMetadata: ExtractedMetadata = { code_urls: [], dataset_mentions: [], benchmark_mentions: [] };
    let boundaryViolations = 0;

    for (const batch of batches) {
      // Check stop signal between batches — abort chunking early
      const stopSignal = context.config.stopSignal as { requested: boolean } | undefined;
      if (stopSignal?.requested) {
        logger.info(`Stop requested — aborting chunking after ${chunks.length} chunks (${batches.indexOf(batch)}/${batches.length} batches)`);
        throw new ChunkingAbortedError();
      }

      batchBounds.push(chunks.length);

      // Stage-2 Part B: try marker (anchor) chunking first — cheaper + verbatim (content
      // recovered from source). On ANY recovery failure tryMarkerBatch returns null and we fall
      // through to the full-text path below (the .12 fallback, which keeps the pro retry,
      // enforceSectionBoundaries, and fixChunkBoundaries).
      const marker = await this.tryMarkerBatch(batch, document, chunkerOptions, context, position);
      if (marker) {
        for (const c of marker.chunks) chunks.push(c);
        position += marker.chunks.length;
        mergedMetadata.code_urls.push(...marker.metadata.code_urls);
        mergedMetadata.dataset_mentions.push(...marker.metadata.dataset_mentions);
        mergedMetadata.benchmark_mentions.push(...marker.metadata.benchmark_mentions);
        continue;
      }

      const prompt = this.buildPrompt(document.title, batch);

      try {
        const start = performance.now();
        const response = await modelRouter.complete('chunking', prompt, chunkerOptions);
        const durationMs = Math.round(performance.now() - start);

        await costTracker.record(
          'chunking',
          response.model,
          response.provider ?? 'openrouter',
          response.inputTokens,
          response.outputTokens,
          response.cost,
          durationMs,
        );

        // Per-batch output validation
        const outputRatio = response.inputTokens > 0 ? response.outputTokens / response.inputTokens : 1;
        // Trigger the pro correctness-retry on EITHER:
        //  - MAX_TOKENS (truncated output — rare without the schema param), OR
        //  - unparseable JSON (the no-schema LaTeX-escape failure mode,
        //    finishReason=STOP but JSON.parse rejects the bad `\command` escape).
        // The retry uses the SCHEMA (retrySchemaOptions) so pro emits correctly
        // escaped JSON for the LaTeX-heavy text the base call tripped on.
        const baseCheck = this.hasValidChunkJson(response.text);
        if (baseCheck.repaired && baseCheck.valid) {
          logger.info(`Chunking base JSON escape-repaired for batch of ${batch.length} sections — pro retry avoided`);
        }
        if (response.finishReason === 'MAX_TOKENS' || !baseCheck.valid) {
          // Fallback: retry with a more capable model (schema-constrained) before
          // paragraph splitting.
          const fallbackModel = 'gemini-3.1-pro-preview';
          const reason = response.finishReason === 'MAX_TOKENS' ? 'MAX_TOKENS' : 'unparseable-json';
          logger.warn(`Chunking base call needs retry (${reason}) for batch of ${batch.length} sections (${response.inputTokens} in → ${response.outputTokens} out). Retrying with ${fallbackModel} + schema...`);

          // Debug log: write prompt + responses for failed batches
          this.debugLogBatch(document.sourceId, prompt, response.text, response, null, null);

          try {
            const retryStart = performance.now();
            const retryResponse = await modelRouter.complete('chunking', prompt, { ...retrySchemaOptions, model: fallbackModel });
            const retryDurationMs = Math.round(performance.now() - retryStart);

            await costTracker.record('chunking', retryResponse.model, retryResponse.provider ?? 'openrouter',
              retryResponse.inputTokens, retryResponse.outputTokens, retryResponse.cost, retryDurationMs);

            // Debug log: fallback response
            this.debugLogBatch(document.sourceId, null, null, null, retryResponse.text, retryResponse);

            if (retryResponse.finishReason === 'MAX_TOKENS' || !this.hasValidChunkJson(retryResponse.text).valid) {
              logger.warn(`Fallback model ${fallbackModel} did not yield parseable chunks (finishReason=${retryResponse.finishReason}, ${retryResponse.outputTokens} out). Falling back to paragraph splitting.`);
            } else {
              logger.info(`Fallback model ${fallbackModel} succeeded (${retryResponse.outputTokens} out, finishReason=${retryResponse.finishReason})`);
              // Use the retry response instead — parse it and continue normally
              const { chunks: retryChunks, metadata: retryMeta } = this.parseResponse(retryResponse.text, batch, document.sourceFormat);
              mergedMetadata.code_urls.push(...retryMeta.code_urls);
              mergedMetadata.dataset_mentions.push(...retryMeta.dataset_mentions);
              mergedMetadata.benchmark_mentions.push(...retryMeta.benchmark_mentions);
              const retryPathByName = new Map<string, string>();
              for (const s of batch) { retryPathByName.set(s.name, s.path); retryPathByName.set(s.path, s.path); }
              const { validated: retryValidated } = this.enforceSectionBoundaries(retryChunks, batch);
              diagLlmResponse(logger, document.sourceId, batch.length, retryChunks, retryValidated.length);
              for (const item of retryValidated) {
                const path = retryPathByName.get(item.section) ?? item.section;
                diagChunkCreated(logger, 'llm-retry-success', {
                  docId: document.id, sourceId: document.sourceId, section: item.section,
                  pos: position, contentLen: item.text.length, meta: item,
                });
                chunks.push(this.createChunk(document.id, item.section, item.text, position++, path, item));
              }
              continue; // success — skip to next batch
            }
          } catch (retryErr) {
            logger.warn(`Fallback model ${fallbackModel} failed: ${retryErr instanceof Error ? retryErr.message : retryErr}. Falling back to paragraph splitting.`);
          }

          // Final fallback: paragraph splitting
          const splitter = document.sourceFormat === 'latex'
            ? (text: string) => this.splitLatex(text)
            : (text: string) => this.splitParagraphs(text);
          for (const section of batch) {
            const paragraphs = splitter(section.content);
            for (const para of paragraphs) {
              diagChunkCreated(logger, 'fallback-after-retry-truncate', {
                docId: document.id, sourceId: document.sourceId, section: section.name,
                pos: position, contentLen: para.length, meta: null,
              });
              chunks.push(this.createChunk(document.id, section.name, para, position++, section.path));
            }
          }
          continue;
        }
        if (outputRatio < 0.05 && response.inputTokens > 1000) {
          logger.warn(`Suspiciously low output ratio (${(outputRatio * 100).toFixed(1)}%) for batch: ${response.inputTokens} in → ${response.outputTokens} out`);
        }

        const { chunks: parsedChunks, metadata: batchMeta } = this.parseResponse(response.text, batch, document.sourceFormat);

        // Enforce section boundaries: split chunks that span multiple sections
        const { validated, violations } = this.enforceSectionBoundaries(parsedChunks, batch);
        if (violations > 0) {
          boundaryViolations += violations;
          logger.debug(`Section boundary enforcement: ${violations} violations fixed in batch`);
        }

        // Merge batch metadata
        mergedMetadata.code_urls.push(...batchMeta.code_urls);
        mergedMetadata.dataset_mentions.push(...batchMeta.dataset_mentions);
        mergedMetadata.benchmark_mentions.push(...batchMeta.benchmark_mentions);

        // Build path lookup from batch sections (map by both name and path)
        const pathByName = new Map<string, string>();
        for (const s of batch) {
          pathByName.set(s.name, s.path);
          pathByName.set(s.path, s.path);
        }

        diagLlmResponse(logger, document.sourceId, batch.length, parsedChunks, validated.length);
        for (const item of validated) {
          const path = pathByName.get(item.section) ?? item.section;
          diagChunkCreated(logger, 'llm-batch-success', {
            docId: document.id, sourceId: document.sourceId, section: item.section,
            pos: position, contentLen: item.text.length, meta: item,
          });
          chunks.push(this.createChunk(document.id, item.section, item.text, position++, path, item));
        }

        logger.debug(`Batch chunked: ${batch.length} sections → ${validated.length} chunks in ${durationMs}ms`);
      } catch (err) {
        logger.warn(`LLM chunking failed for batch of ${batch.length} sections, falling back to paragraph splitting`);

        // Fallback: split each section (LaTeX-aware or plain paragraph splitting)
        const splitter = document.sourceFormat === 'latex'
          ? (text: string) => this.splitLatex(text)
          : (text: string) => this.splitParagraphs(text);
        for (const section of batch) {
          const paragraphs = splitter(section.content);
          for (const para of paragraphs) {
            diagChunkCreated(logger, 'fallback-after-exception', {
              docId: document.id, sourceId: document.sourceId, section: section.name,
              pos: position, contentLen: para.length, meta: null,
            });
            chunks.push(this.createChunk(document.id, section.name, para, position++, section.path));
          }
        }
      }
    }

    // Deduplicate extracted metadata across batches
    const dedupedMetadata: ExtractedMetadata = {
      code_urls: [...new Set(mergedMetadata.code_urls)],
      dataset_mentions: [...new Set(mergedMetadata.dataset_mentions)],
      benchmark_mentions: [...new Set(mergedMetadata.benchmark_mentions)],
    };

    // Save extracted metadata to DB and document object
    const hasMetadata =
      dedupedMetadata.code_urls.length > 0 ||
      dedupedMetadata.dataset_mentions.length > 0 ||
      dedupedMetadata.benchmark_mentions.length > 0;

    if (hasMetadata) {
      await query(
        'UPDATE documents SET extracted_metadata = $1 WHERE id = $2',
        [JSON.stringify(dedupedMetadata), document.id],
      );
      document.extractedMetadata = dedupedMetadata;
      logger.info(
        `Extracted metadata: ${dedupedMetadata.code_urls.length} code URLs, ${dedupedMetadata.dataset_mentions.length} datasets, ${dedupedMetadata.benchmark_mentions.length} benchmarks`,
      );
    }

    if (boundaryViolations > 0) {
      logger.info(`Section boundary enforcement: ${boundaryViolations} violations fixed`);
    }

    // Section coverage check: how many input sections are represented in output chunks?
    const inputSections = new Set(substantive.map((s) => s.path));
    const outputSections = new Set(chunks.map((c) => c.context.sectionPath).filter(Boolean));
    const missedSections = [...inputSections].filter((s) => !outputSections.has(s));
    if (missedSections.length > inputSections.size * 0.5 && inputSections.size > 2) {
      logger.warn(`Section coverage low: ${outputSections.size}/${inputSections.size} sections in chunks (${missedSections.length} missing)`);
    }

    // Fix mid-sentence chunk boundaries (trim backward to last complete sentence). GATED to the
    // full-text / fallback chunks only — marker chunks are already verbatim, 0-loss, cleanly-tiled
    // slices; trimming them would DISCARD recovered content (violates the Part B 0-loss invariant).
    // fixChunkBoundaries mutates in place, so the filtered subset shares the same chunk objects.
    const boundaryFixes = fixChunkBoundaries(chunks.filter((c) => c.context.chunkingMode !== 'marker'));
    if (boundaryFixes > 0) {
      logger.info(`Fixed ${boundaryFixes} mid-sentence chunk boundaries`);
    }

    // Cross-batch dedup: remove near-duplicate chunks at batch boundaries
    const beforeDedup = chunks.length;
    const dedupCount = this.crossBatchDedup(chunks, batchBounds);
    if (dedupCount > 0) {
      logger.info(`Cross-batch dedup removed ${dedupCount} duplicate chunks`);
    }

    // Filter garbage chunks: too short or mostly non-alphanumeric
    const beforeFilter = chunks.length;
    const filteredChunks = this.filterGarbageChunks(chunks);
    if (filteredChunks > 0) {
      logger.info(`Filtered ${filteredChunks} garbage chunks`);
    }

    // Re-number positions after dedup + filter
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].context.positionInDocument = i;
    }

    // Record counts in quality_flags
    const flags: Record<string, number | string[]> = {};
    if (boundaryFixes > 0) flags.boundary_fixes = boundaryFixes;
    if (missedSections.length > 0) flags.missed_sections = missedSections;
    if (boundaryViolations > 0) flags.section_boundary_violations = boundaryViolations;
    if (dedupCount > 0) flags.cross_batch_dedup = dedupCount;
    if (filteredChunks > 0) flags.filtered_chunks = filteredChunks;
    if (filteredSections > 0) flags.filtered_sections = filteredSections;
    if (Object.keys(flags).length > 0) {
      await query(
        `UPDATE documents SET quality_flags = COALESCE(quality_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify(flags), document.id],
      );
    }

    this.setTotalChunks(chunks, chunks.length);
    logger.info(`Chunking complete: ${chunks.length} total chunks (${beforeDedup} before dedup/filter)`);

    return chunks;
  }

  private flattenSections(sections: ParsedSection[], parentPath = ''): FlatSection[] {
    const result: FlatSection[] = [];
    for (const section of sections) {
      const path = parentPath ? `${parentPath} > ${section.name}` : section.name;
      result.push({ ...section, path });
      if (section.subsections?.length) {
        result.push(...this.flattenSections(section.subsections, path));
      }
    }
    return result;
  }

  /** Max chars for a single section before it gets split into sub-sections.
   *  200K chars ≈ 50K tokens — safely under Gemini's 65K output token limit.
   *  Normal sections (99.9%) pass through unchanged. */
  private static readonly GIANT_SECTION_LIMIT = 130_000;

  private groupIntoBatches(sections: FlatSection[]): FlatSection[][] {
    const batches: FlatSection[][] = [];
    let current: FlatSection[] = [];
    let currentLen = 0;

    for (const section of sections) {
      // Split giant sections (>200K chars) into paragraph-based sub-sections
      // to prevent exceeding model output token limit
      const parts = section.content.length > ChunkerStep.GIANT_SECTION_LIMIT
        ? this.splitGiantSection(section)
        : [section];

      for (const part of parts) {
        // If adding this section exceeds limit and batch is non-empty, close batch
        if (currentLen + part.content.length > BATCH_CHAR_LIMIT && current.length > 0) {
          batches.push(current);

          // Overlap: carry the last section into the next batch (~250 chars context)
          const lastSection = current[current.length - 1];
          if (lastSection.content.length <= 500) {
            current = [lastSection];
            currentLen = lastSection.content.length;
          } else {
            current = [];
            currentLen = 0;
          }
        }
        current.push(part);
        currentLen += part.content.length;
      }
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  }

  /** Split a giant section into sub-sections by paragraphs, each under GIANT_SECTION_LIMIT. */
  private splitGiantSection(section: FlatSection): FlatSection[] {
    const paragraphs = section.content.split(/\n\n+/);
    const parts: FlatSection[] = [];
    let current = '';
    let partIdx = 0;

    for (const para of paragraphs) {
      if (current.length + para.length > ChunkerStep.GIANT_SECTION_LIMIT && current.length > 0) {
        parts.push({ ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` });
        current = para;
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }
    if (current.trim().length > 0) {
      parts.push(parts.length > 0
        ? { ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` }
        : { ...section, content: current.trim() }); // single part = keep original name
    }
    return parts;
  }

  private buildPrompt(title: string, sections: FlatSection[], mode: 'marker' | 'full_text' = 'full_text'): string {
    const sectionTexts = sections
      .map((s) => `---SECTION: ${s.path}---\n${s.content}`)
      .join('\n\n');

    // Output-spec differs by mode. marker: emit start/end anchors (verbatim first/last ~8
    // words) instead of the full text — the content is recovered from source (Stage-2 Part B:
    // cheaper + no distortion). full_text: the legacy spec (also used for the marker fallback).
    const outputSpec = mode === 'marker'
      ? `Do NOT return the full chunk text. For EACH chunk return ONLY its boundary markers:
- "sa" (start anchor): the FIRST ~8 words of the chunk, copied EXACTLY character-for-character from the source above (verbatim).
- "ea" (end anchor): the LAST ~8 words of the chunk, copied EXACTLY character-for-character (verbatim).
Copy anchors verbatim — do NOT paraphrase, normalize, translate, fix, or drop any LaTeX/math/punctuation. The anchors must appear literally in the source so the full text can be reconstructed.

Use SHORT field names exactly as shown (they cost fewer tokens):
  sec = section header, sa = start_anchor, ea = end_anchor, sum = summary,
  kc = key concept, ct = content type, ent = entities, sc = self contained.

Return ONLY a JSON object with two keys:
1. "chunks": [{"sec": "exact section header from above", "sa": "first ~8 words verbatim", "ea": "last ~8 words verbatim", "sum": "1-2 sentence summary", "kc": "main idea in 3-5 words", "ct": "methodology", "ent": ["BERT", "SQuAD"], "sc": true}, ...]
2. "metadata": {"code_urls": ["https://github.com/..."], "dataset_mentions": ["ImageNet", ...], "benchmark_mentions": ["BLEU", ...]}`
      : `Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "exact section header from above", "text": "chunk text", "summary": "1-2 sentence summary", "key_concept": "main idea in 3-5 words", "content_type": "methodology", "entities": ["BERT", "SQuAD"], "self_contained": true}, ...]
2. "metadata": {"code_urls": ["https://github.com/..."], "dataset_mentions": ["ImageNet", ...], "benchmark_mentions": ["BLEU", ...]}`;

    return `Split the following paper sections into semantic units.
Each unit = one complete thought/claim/concept. Preserve original text exactly.
Target 100-500 words per chunk. Keep formulas with their explanations.

CRITICAL chunking rules:
- Every chunk MUST end at a complete sentence boundary. Never cut a sentence in the middle.
- For LaTeX source: do NOT split inside \\begin{...}...\\end{...} environments, math blocks ($...$, \\[...\\]), figure/table captions, or \\item lists. Keep these atomic — include the full environment in one chunk.
- Each chunk MUST belong to exactly ONE section. Never combine text from different sections into one chunk.
- For "section", use the EXACT section header as shown (including any ">" hierarchy).

CRITICAL: For EVERY chunk you MUST populate ALL of the following fields. Do NOT omit any required field.

1. summary (REQUIRED, string): 1-2 sentences capturing the core claim. For pure-formula or proof chunks, summarize what the formula/proof establishes (e.g. "Defines the cross-entropy loss used during training" or "Proves convergence of Algorithm 1 under Assumption 2").
2. key_concept (REQUIRED, string): the main idea in 3-5 words. For pure-formula chunks, name the formula or concept (e.g. "cross-entropy loss", "diffusion equation", "convergence proof").
3. content_type (REQUIRED, enum): exactly one of "theoretical", "methodology", "experimental", "results", "survey", "background", "other". Use "theoretical" for proofs, derivations, and pure-formula chunks. Use "other" only as last resort when no other category fits.
4. entities (array of strings): named entities mentioned — method names (e.g. "BERT", "LoRA"), dataset names ("ImageNet", "SQuAD"), metric names ("BLEU", "F1"). Only proper names, not generic terms like "neural network". Empty array [] is acceptable when no proper names appear.
5. self_contained (REQUIRED, boolean): true if this chunk can be understood standalone, false if it depends on prior context.

Document: "${title}"
Sections:
${sectionTexts}

${outputSpec}

For metadata, extract ONLY what is explicitly mentioned in the text above. Return empty arrays if nothing found.`;
  }

  /**
   * Strict check: does `text` parse to JSON with at least one chunk that has a
   * non-empty `text`? Unlike parseResponse (which silently paragraph-splits on
   * failure), this returns false so the caller can route a failed batch to the
   * schema-constrained pro retry instead of accepting null-meta paragraph chunks.
   * Mirrors parseResponse's accepted shapes ({chunks:[...]} and bare array).
   */
  private hasValidChunkJson(text: string): { valid: boolean; repaired: boolean } {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    try {
      const { parsed, repaired } = parseChunkJson(cleaned);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).chunks : null);
      const valid = Array.isArray(arr) && arr.some(
        (c) => c && typeof (c as ChunkJson).text === 'string' && ((c as ChunkJson).text as string).length > 0,
      );
      return { valid, repaired };
    } catch {
      return { valid: false, repaired: false };
    }
  }

  private parseResponse(text: string, fallbackSections: FlatSection[], sourceFormat?: string): ChunkerResponse {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const { parsed } = parseChunkJson(cleaned);

      // New format: { chunks: [...], metadata: {...} }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const chunks = obj.chunks as ChunkJson[] | undefined;
        if (Array.isArray(chunks) && chunks.length > 0) {
          // Validate every chunk has a non-empty .text field (not just chunks[0]).
          // Malformed chunks (missing/empty text) would crash downstream .replace() calls.
          // Sanitize all string fields for PG TEXT compatibility (strip NUL,
          // lone surrogates, control chars) — see sanitizeForPg comment.
          const validChunks = chunks
            .filter(c => c && typeof c.text === 'string' && c.text.length > 0)
            .map(sanitizeChunkJson)
            .filter(c => typeof c.text === 'string' && c.text.length > 0); // re-check after sanitize
          if (validChunks.length > 0) {
            const meta = obj.metadata as Partial<ExtractedMetadata> | undefined;
            return {
              chunks: validChunks,
              metadata: sanitizeMetadata(meta),
            };
          }
          // All chunks malformed — fall through to paragraph splitting
        }
      }

      // Old format: ChunkJson[] array (backward compatibility)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const validChunks = (parsed as ChunkJson[])
          .filter(c => c && typeof c.text === 'string' && c.text.length > 0)
          .map(sanitizeChunkJson)
          .filter(c => typeof c.text === 'string' && c.text.length > 0);
        if (validChunks.length > 0) {
          return { chunks: validChunks, metadata: { ...EMPTY_METADATA } };
        }
      }
    } catch {
      // Fall through to paragraph splitting
    }

    // Fallback: paragraph splitting (LaTeX-aware if applicable).
    // Source content can also contain NUL bytes / stray surrogates (rare,
    // but seen in arXiv PDFs); sanitize for consistency with the JSON path.
    const result: ChunkJson[] = [];
    const splitter = sourceFormat === 'latex'
      ? (t: string) => this.splitLatex(t)
      : (t: string) => this.splitParagraphs(t);
    for (const section of fallbackSections) {
      const paragraphs = splitter(section.content);
      for (const para of paragraphs) {
        result.push({ section: sanitizeForPg(section.name), text: sanitizeForPg(para) });
      }
    }
    return { chunks: result, metadata: { ...EMPTY_METADATA } };
  }

  // ─── Stage-2 Part B: marker (anchor) chunking ────────────────────────────

  /** Strict check for the marker path: JSON with at least one chunk having non-empty
   *  start_anchor + end_anchor. Mirrors hasValidChunkJson. */
  private hasValidAnchorJson(text: string): { valid: boolean; repaired: boolean } {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    try {
      const { parsed, repaired } = parseChunkJson(cleaned);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).chunks : null);
      const valid = Array.isArray(arr) && arr.some((c) => {
        const a = normaliseAnchorChunk(c);
        return !!a && typeof a.start_anchor === 'string' && a.start_anchor.length > 0
          && typeof a.end_anchor === 'string' && a.end_anchor.length > 0;
      });
      return { valid, repaired };
    } catch {
      return { valid: false, repaired: false };
    }
  }

  /** Parse a marker-mode response into AnchorChunkJson[] + metadata. No paragraph fallback —
   *  a parse/validity failure returns [] and the caller falls back to the full-text path. */
  private parseAnchorResponse(text: string): { chunks: AnchorChunkJson[]; metadata: ExtractedMetadata } {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    try {
      const { parsed } = parseChunkJson(cleaned);
      const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : null;
      const rawList = (obj?.chunks ?? (Array.isArray(parsed) ? parsed : null)) as unknown[] | null;
      if (Array.isArray(rawList)) {
        // normalise wire→internal, then keep only chunks that actually carry both anchors —
        // that check is what turns a Partial into a usable AnchorChunkJson.
        const raw = rawList
          .map(normaliseAnchorChunk)
          .filter((c): c is AnchorChunkJson =>
            c !== null && typeof c.start_anchor === 'string' && typeof c.end_anchor === 'string'
            && typeof c.section === 'string');
        const chunks = raw
          .filter((c) => c && typeof c.start_anchor === 'string' && c.start_anchor.length > 0
            && typeof c.end_anchor === 'string' && c.end_anchor.length > 0)
          .map((c) => ({
            ...c,
            section: typeof c.section === 'string' ? sanitizeForPg(c.section) : c.section,
            start_anchor: sanitizeForPg(c.start_anchor),
            end_anchor: sanitizeForPg(c.end_anchor),
            summary: typeof c.summary === 'string' ? sanitizeForPg(c.summary) : c.summary,
            key_concept: typeof c.key_concept === 'string' ? sanitizeForPg(c.key_concept) : c.key_concept,
            content_type: typeof c.content_type === 'string' ? sanitizeForPg(c.content_type) : c.content_type,
            entities: Array.isArray(c.entities)
              ? c.entities.filter((e): e is string => typeof e === 'string').map(sanitizeForPg)
              : c.entities,
          }));
        const meta = obj ? (obj.metadata as Partial<ExtractedMetadata> | undefined) : undefined;
        return { chunks, metadata: sanitizeMetadata(meta) };
      }
    } catch {
      /* fall through */
    }
    return { chunks: [], metadata: { ...EMPTY_METADATA } };
  }

  /**
   * Marker path for one batch (Stage-2 Part B). Emits anchors, recovers verbatim content from
   * the SAME batch source the model saw, and gates on a 0-loss coverage check. Returns the
   * recovered chunks on success, or NULL to fall through to the existing full-text path (.12
   * fallback — which keeps the pro-retry, enforceSectionBoundaries, and fixChunkBoundaries).
   * The lossy boundary machinery is thereby GATED OUT of the marker path (0-silent-wrong).
   */
  private async tryMarkerBatch(
    batch: FlatSection[],
    document: Document,
    chunkerOptions: ModelOptions,
    context: PipelineContext,
    startPos: number,
  ): Promise<{ chunks: Chunk[]; metadata: ExtractedMetadata } | null> {
    const { modelRouter, logger, costTracker } = context;
    const prompt = this.buildPrompt(document.title, batch, 'marker');

    let response;
    const start = performance.now();
    try {
      response = await modelRouter.complete('chunking', prompt, chunkerOptions);
    } catch (err) {
      logger.warn(`Marker chunking LLM call failed (${err instanceof Error ? err.message : err}) — full-text fallback`);
      return null;
    }
    const durationMs = Math.round(performance.now() - start);
    await costTracker.record('chunking', response.model, response.provider ?? 'openrouter',
      response.inputTokens, response.outputTokens, response.cost, durationMs);

    // Unparseable / truncated marker JSON → full-text path (which has its own pro retry). Rare
    // (~3%: marker valid-JSON ≈ 96.7% vs 80.3% full-text — short anchors trip LaTeX escaping less).
    if (response.finishReason === 'MAX_TOKENS' || !this.hasValidAnchorJson(response.text).valid) {
      logger.info(`Marker batch unusable (finishReason=${response.finishReason}) — full-text fallback for ${batch.length} sections`);
      return null;
    }

    const { chunks: anchorChunks, metadata } = this.parseAnchorResponse(response.text);
    if (anchorChunks.length === 0) return null;

    // Recover from the EXACT in-loop batch source (header-less) — this is batchRawContent(batch),
    // inlined to avoid FlatSection type coupling; alignment (0-silent-wrong) is guaranteed because
    // we recover from the same batch the model was given.
    const source = batch.map((s) => s.content).join('\n');
    const pairs: Array<[string, string]> = anchorChunks.map((c) => [c.start_anchor, c.end_anchor]);
    const results = recoverFromAnchorPairs(pairs, source);

    // 0-loss gate: any FAILED anchor, or any real (non-droppable) coverage gap / non-clean tiling
    // → NULL → full-text fallback. Accepted only when every chunk's content is a byte-exact
    // source slice AND the batch tiles cleanly. Content is never LLM-serialized in this path.
    if (results.some((r) => r.status === 'FAILED' || r.span === null || r.text === null)) {
      logger.info(`Marker recovery had FAILED anchors (${batch.length} sections) — full-text fallback`);
      return null;
    }
    const cov = coverageCheck(results.map((r) => r.span), source);
    if (cov.gaps.length > 0 || !cov.cleanTiling) {
      logger.info(`Marker recovery not 0-loss (gaps=${cov.gaps.length}, cleanTiling=${cov.cleanTiling}, ${batch.length} sections) — full-text fallback`);
      return null;
    }

    const pathByName = new Map<string, string>();
    for (const s of batch) { pathByName.set(s.name, s.path); pathByName.set(s.path, s.path); }
    const chunks: Chunk[] = [];
    let pos = startPos;
    for (let i = 0; i < anchorChunks.length; i++) {
      const a = anchorChunks[i];
      const content = results[i].text as string; // non-null: guarded above
      const meta: ChunkJson = {
        section: a.section, text: content, summary: a.summary, key_concept: a.key_concept,
        content_type: a.content_type, entities: a.entities, self_contained: a.self_contained,
      };
      const path = pathByName.get(a.section) ?? a.section;
      chunks.push(this.createChunk(document.id, a.section, content, pos++, path, meta, 'marker'));
    }
    logger.debug(`Marker batch: ${batch.length} sections → ${chunks.length} verbatim-recovered chunks in ${durationMs}ms`);
    return { chunks, metadata };
  }

  private splitParagraphs(text: string): string[] {
    return text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 50); // Skip very short fragments
  }

  /** LaTeX-aware splitting: structural markers → sub-split oversized by \n */
  private splitLatex(text: string): string[] {
    const maxChars = parseInt(process.env.GUARD_MAX_CHUNK_CHARS ?? '5000', 10);

    // Step 1: Split on structural LaTeX markers (lookahead — marker stays with its content)
    const STRUCTURAL_RE = /(?=\\(?:section|subsection|subsubsection|paragraph|chapter)\*?\{)|(?=\\begin\{(?:thebibliography|longtable|table|figure|algorithm|theorem|lemma|proof|corollary|definition|example|remark)\*?\})|(?=\\bibitem[\s\[])/;
    const structural = text.split(STRUCTURAL_RE).map((p) => p.trim()).filter((p) => p.length > 50);

    // Step 2: Sub-split oversized chunks
    const result: string[] = [];
    for (const chunk of structural) {
      if (chunk.length <= maxChars) {
        result.push(chunk);
        continue;
      }

      // Try \n\n split first
      const paras = chunk.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 50);
      if (paras.length > 1 && paras.every((p) => p.length <= maxChars)) {
        result.push(...paras);
        continue;
      }

      // Accumulate lines up to maxChars
      const lines = chunk.split(/\n/).map((p) => p.trim()).filter((p) => p.length > 30);
      let current = '';
      for (const line of lines) {
        if (current.length + line.length + 1 > maxChars && current.length > 50) {
          result.push(current.trim());
          current = line;
        } else {
          current += (current ? '\n' : '') + line;
        }
      }
      if (current.trim().length > 50) result.push(current.trim());
    }

    return result;
  }

  /**
   * Abstract chunks bypass the LLM enrichment step but should still surface
   * a populated context (contentType=abstract, selfContained=true, summary).
   * documentTitle is set later (during indexer write) — we leave it empty
   * here matching the existing createChunk pattern.
   */
  private createAbstractChunk(
    documentId: string,
    abstract: string,
    position: number,
    documentTitle: string,
  ): Chunk {
    const ctx = buildAbstractChunkContext(abstract, documentTitle, 0);
    return {
      id: randomUUID(),
      version: 1,
      createdAt: new Date(),
      documentId,
      content: abstract,
      context: {
        ...ctx,
        positionInDocument: position,
      },
      vectors: {},
      metrics: {},
      qdrantPointId: randomUUID(),
    };
  }

  private createChunk(
    documentId: string,
    sectionName: string,
    content: string,
    position: number,
    sectionPath?: string,
    meta?: ChunkJson,
    chunkingMode: 'marker' | 'full_text' = 'full_text',
  ): Chunk {
    const contentType = meta?.content_type && VALID_CONTENT_TYPES.has(meta.content_type)
      ? meta.content_type
      : undefined;
    const entities = Array.isArray(meta?.entities) && meta.entities.length > 0
      ? meta.entities.filter((e): e is string => typeof e === 'string' && e.length > 0)
      : undefined;

    return {
      id: randomUUID(),
      version: 1,
      createdAt: new Date(),
      documentId,
      content,
      context: {
        documentTitle: '',
        sectionName,
        sectionPath: sectionPath ?? sectionName,
        positionInDocument: position,
        totalChunks: 0,
        chunkingMode,
        ...(meta?.summary ? { summary: meta.summary } : {}),
        ...(meta?.key_concept ? { keyConcept: meta.key_concept } : {}),
        ...(contentType ? { contentType } : {}),
        ...(entities ? { entities } : {}),
        ...(typeof meta?.self_contained === 'boolean' ? { selfContained: meta.self_contained } : {}),
      },
      vectors: {},
      metrics: {},
      // Stable Qdrant point ID assigned at creation so retries/resumes don't
      // create duplicate points (previously assigned in indexer-step).
      qdrantPointId: randomUUID(),
    };
  }

  /**
   * Remove garbage chunks: too short or mostly non-alphanumeric symbols.
   * Mutates the array in place. Returns count of removed chunks.
   */
  /**
   * Enforce section boundaries: detect chunks whose text spans multiple sections
   * and split them at the section boundary. Returns validated chunks + violation count.
   */
  private enforceSectionBoundaries(
    chunks: ChunkJson[],
    sections: FlatSection[],
  ): { validated: ChunkJson[]; violations: number } {
    if (sections.length <= 1) {
      // Single section in batch — no cross-section violations possible
      return { validated: chunks, violations: 0 };
    }

    // Build ordered list of section contents for boundary detection.
    // Skip sections without .content — defensive, shouldn't happen but avoids crash.
    const sectionOrder = sections
      .filter((s) => typeof s.content === 'string')
      .map((s) => ({
        path: s.path,
        name: s.name,
        // Normalize whitespace for matching
        content: s.content.replace(/\s+/g, ' ').trim(),
      }));

    const result: ChunkJson[] = [];
    let violations = 0;

    for (const chunk of chunks) {
      // Defensive: skip chunks without valid text (parseResponse should already filter,
      // but belt+suspenders — prevents crash on malformed LLM output).
      if (typeof chunk.text !== 'string' || chunk.text.length === 0) continue;
      const chunkText = chunk.text.replace(/\s+/g, ' ').trim();

      // Find which section(s) contain this chunk's text
      const matchingSections: Array<{ section: typeof sectionOrder[number]; startIdx: number }> = [];
      for (const sec of sectionOrder) {
        // Use first 80 chars of chunk as probe (LLM may rephrase slightly)
        const probe = chunkText.slice(0, 80);
        const idx = sec.content.indexOf(probe);
        if (idx !== -1) {
          matchingSections.push({ section: sec, startIdx: idx });
        }
      }

      if (matchingSections.length <= 1) {
        // Text found in 0 or 1 section — no violation (0 = LLM rephrased, keep as-is)
        result.push(chunk);
        continue;
      }

      // Text found in multiple sections — this shouldn't happen normally.
      // More likely: text SPANS a section boundary. Find where the boundary is.
      // Strategy: find the declared section, then check if chunk text extends past it.
      const declaredSec = sectionOrder.find((s) => s.path === chunk.section || s.name === chunk.section);
      if (!declaredSec) {
        result.push(chunk);
        continue;
      }

      // Find where declared section's content ends in the chunk
      const declaredContent = declaredSec.content;
      // Find overlap: how much of the chunk is in the declared section
      const overlapEnd = this.findOverlapEnd(chunkText, declaredContent);

      if (overlapEnd <= 0 || overlapEnd >= chunkText.length - MIN_CHUNK_CHARS) {
        // No clear boundary or remainder too short — keep as-is
        result.push(chunk);
        continue;
      }

      // Split at boundary
      violations++;
      const part1Text = chunk.text.slice(0, this.findOriginalIndex(chunk.text, chunkText, overlapEnd)).trim();
      const part2Text = chunk.text.slice(this.findOriginalIndex(chunk.text, chunkText, overlapEnd)).trim();

      // Find which section owns part2
      const nextSec = sectionOrder.find((s) => s !== declaredSec && s.content.includes(part2Text.replace(/\s+/g, ' ').trim().slice(0, 60)));

      if (part1Text.length >= MIN_CHUNK_CHARS) {
        result.push({ ...chunk, text: part1Text });
      }
      if (part2Text.length >= MIN_CHUNK_CHARS) {
        result.push({
          ...chunk,
          text: part2Text,
          section: nextSec?.path ?? nextSec?.name ?? chunk.section,
          // Clear enriched metadata for the split part (may not apply)
          summary: undefined,
          key_concept: undefined,
          content_type: undefined,
          entities: undefined,
          self_contained: undefined,
        });
      }
    }

    return { validated: result, violations };
  }

  /** Find how far into normalizedChunk the declaredSection content extends. */
  private findOverlapEnd(normalizedChunk: string, normalizedSection: string): number {
    // Find the longest prefix of chunk that appears in the section
    // Use binary search on chunk length
    let lo = 0;
    let hi = normalizedChunk.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (normalizedSection.includes(normalizedChunk.slice(0, mid))) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  /** Map from normalized string index back to original string index. */
  private findOriginalIndex(original: string, _normalized: string, normalizedIdx: number): number {
    // Walk original string, counting non-collapsed characters
    let ni = 0;
    let inSpace = false;
    for (let oi = 0; oi < original.length; oi++) {
      if (/\s/.test(original[oi])) {
        if (!inSpace) { ni++; inSpace = true; }
      } else {
        ni++;
        inSpace = false;
      }
      if (ni >= normalizedIdx) return oi + 1;
    }
    return original.length;
  }

  private filterGarbageChunks(chunks: Chunk[]): number {
    let removed = 0;
    for (let i = chunks.length - 1; i >= 0; i--) {
      // Defensive: chunks with undefined/non-string content are garbage — remove them.
      // This can happen if upstream passed malformed ChunkJson to createChunk.
      const content = chunks[i].content;
      if (typeof content !== 'string') {
        chunks.splice(i, 1);
        removed++;
        continue;
      }
      const text = content.trim();

      // Too short
      if (text.length < MIN_CHUNK_CHARS) {
        chunks.splice(i, 1);
        removed++;
        continue;
      }

      // Mostly non-alphanumeric (diagram garbage)
      const alnumCount = text.replace(/[^a-zA-Z0-9]/g, '').length;
      if (alnumCount / text.length < 1 - MAX_NON_ALNUM_RATIO) {
        chunks.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove near-duplicate chunks at batch boundaries.
   * Compares last 2 chunks of batch N with first 2 of batch N+1.
   * Returns count of removed duplicates.
   */
  private crossBatchDedup(chunks: Chunk[], batchBounds: number[]): number {
    const toRemove = new Set<number>();

    for (let b = 1; b < batchBounds.length; b++) {
      const prevStart = batchBounds[b - 1];
      const currStart = batchBounds[b];
      const currEnd = b + 1 < batchBounds.length ? batchBounds[b + 1] : chunks.length;

      // Last 2 chunks of previous batch
      const prevTail = [];
      for (let i = Math.max(prevStart, currStart - 2); i < currStart; i++) {
        if (!toRemove.has(i)) prevTail.push(i);
      }

      // First 2 chunks of current batch
      const currHead = [];
      for (let i = currStart; i < Math.min(currStart + 2, currEnd); i++) {
        if (!toRemove.has(i)) currHead.push(i);
      }

      // Compare each pair
      for (const pi of prevTail) {
        for (const ci of currHead) {
          if (toRemove.has(ci)) continue;
          const sim = textSimilarity(chunks[pi].content, chunks[ci].content);
          if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
            // Keep the longer chunk, remove the shorter
            if (chunks[pi].content.length >= chunks[ci].content.length) {
              toRemove.add(ci);
            } else {
              toRemove.add(pi);
            }
          }
        }
      }
    }

    if (toRemove.size === 0) return 0;

    // Remove in reverse order to preserve indices
    const sorted = [...toRemove].sort((a, b) => b - a);
    for (const idx of sorted) {
      chunks.splice(idx, 1);
    }

    return toRemove.size;
  }

  private setTotalChunks(chunks: Chunk[], total: number): void {
    for (const chunk of chunks) {
      chunk.context.totalChunks = total;
    }
  }

  /** Write debug info for MAX_TOKENS batches to JSONL file. */
  private debugLogBatch(
    arxivId: string,
    prompt: string | null,
    flashResponse: string | null,
    flashMeta: { inputTokens: number; outputTokens: number; finishReason?: string; model: string } | null,
    proResponse: string | null,
    proMeta: { inputTokens: number; outputTokens: number; finishReason?: string; model: string } | null,
  ): void {
    try {
      const dataDir = process.env.RUNNER_DATA_DIR ?? '.';
      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        arxivId,
      };
      if (prompt) entry.prompt = prompt;
      if (flashResponse) {
        entry.flash_response = flashResponse;
        entry.flash_meta = flashMeta;
      }
      if (proResponse) {
        entry.pro_response = proResponse;
        entry.pro_meta = proMeta;
      }
      import('node:fs/promises').then(({ appendFile }) =>
        appendFile(`${dataDir}/chunking-debug.jsonl`, JSON.stringify(entry) + '\n'),
      ).catch(() => { /* non-critical */ });
    } catch { /* non-critical */ }
  }
}
