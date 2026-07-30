/**
 * chunking-modes-experiment — measure chunking cost vs quality across model
 * configurations, on REAL LaTeX documents through the REAL current parser.
 *
 * WHY: the chunking step regressed from ≤$0.10/doc to ~$0.32/doc. Root cause
 * (confirmed via git, openarx-cmnj): the `responseSchema` PARAMETER added in
 * 29a816c auto-enables Gemini-3 thinking, which inflates output tokens (flash
 * output = $3/M) and causes a MAX_TOKENS→pro-fallback storm. Before 29a816c the
 * working config was `thinkingConfig:{thinkingBudget:0}` + NO responseSchema
 * (schema described IN THE PROMPT) → ~1900 out/call, ~$0.08/doc.
 *
 * This script reproduces the production chunking mechanics EXACTLY except for
 * the one axis we're studying — the model generationConfig (thinking / temp /
 * schema). For each variant it runs the same prompt over the same batches,
 * validates the JSON, and applies the proposed two-tier retry:
 *   - split_fail / MAX_TOKENS  → retry WHOLE batch with schema+minimal (then pro)
 *   - meta_gap (split OK, meta fields bad) → retry META ONLY (tiny output)
 * and reports per-variant cost (base + retries) and quality (split/meta rates).
 *
 * FAITHFULNESS:
 *   - Parser: reuses LatexStrategy (lazy-extracts eprint→source/, parses, cleans
 *     up) — the exact production parse path. LaTeX-only, no PDF fallback.
 *   - Chunker mechanics (flattenSections, groupIntoBatches, splitGiantSection,
 *     buildPrompt, CHUNKER_RESPONSE_SCHEMA, constants) are MIRRORED verbatim from
 *     packages/ingest/src/pipeline/chunker-step.ts with line refs. Keep in sync.
 *   - Vertex call mirrors packages/api/src/model-router/vertex-llm.ts callApi
 *     (API-key mode — the mode S1 uses for LLM) but with a configurable
 *     generationConfig so each variant controls thinking/temp/schema.
 *
 * Usage (from the repository root, with .env loaded so DATABASE_URL + GOOGLE_AI_API_KEY are set):
 *   set -a && . ./.env && set +a && \
 *     pnpm --filter @openarx/ingest exec tsx \
 *       src/scripts/chunking-modes-experiment.ts \
 *       [--limit 10] [--variants v0,v1,v2,v3,v4] [--doc-concurrency 3] \
 *       [--out /tmp/chunking-modes] [--source-ids id1,id2,...]
 *
 * Output:
 *   <out>-batches.jsonl  — one record per (doc, variant, batch)
 *   <out>-summary.json   — per-variant aggregate
 *   stderr               — human-readable summary table
 */

import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { query, pool } from '@openarx/api';
import type { Document, ParsedDocument, ParsedSection, PipelineContext } from '@openarx/types';
import { LatexStrategy } from '../parsers/parse-strategy.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('chunk-experiment');

// ─── Mirrored from chunker-step.ts (KEEP IN SYNC) ──────────────────────────
// chunker-step.ts:306-309
const BATCH_CHAR_LIMIT = 3500;
const MIN_SECTION_CHARS = 30;
// chunker-step.ts:615
const GIANT_SECTION_LIMIT = 130_000;

const VALID_CONTENT_TYPES = [
  'theoretical', 'methodology', 'experimental',
  'results', 'survey', 'background', 'other',
] as const;

// chunker-step.ts:125-157 (verbatim)
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

// Meta-only retry schema — mirror of backfill-chunk-metadata.ts:66-86
const META_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['annotations'],
  properties: {
    annotations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['chunk_index', 'content_type', 'summary', 'key_concept', 'self_contained', 'entities'],
        properties: {
          chunk_index: { type: 'INTEGER' },
          content_type: { type: 'STRING', enum: [...VALID_CONTENT_TYPES] },
          summary: { type: 'STRING' },
          key_concept: { type: 'STRING' },
          self_contained: { type: 'BOOLEAN' },
          entities: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

interface FlatSection extends ParsedSection {
  path: string;
}

// chunker-step.ts:600-610 (verbatim)
function flattenSections(sections: ParsedSection[], parentPath = ''): FlatSection[] {
  const result: FlatSection[] = [];
  for (const section of sections) {
    const path = parentPath ? `${parentPath} > ${section.name}` : section.name;
    result.push({ ...section, path });
    if (section.subsections?.length) {
      result.push(...flattenSections(section.subsections, path));
    }
  }
  return result;
}

// chunker-step.ts:657-677 (verbatim)
function splitGiantSection(section: FlatSection): FlatSection[] {
  const paragraphs = section.content.split(/\n\n+/);
  const parts: FlatSection[] = [];
  let current = '';
  let partIdx = 0;
  for (const para of paragraphs) {
    if (current.length + para.length > GIANT_SECTION_LIMIT && current.length > 0) {
      parts.push({ ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` });
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim().length > 0) {
    parts.push(parts.length > 0
      ? { ...section, content: current.trim(), name: `${section.name} [part ${++partIdx}]`, path: `${section.path} [part ${partIdx}]` }
      : { ...section, content: current.trim() });
  }
  return parts;
}

// chunker-step.ts:617-653 (verbatim)
function groupIntoBatches(sections: FlatSection[]): FlatSection[][] {
  const batches: FlatSection[][] = [];
  let current: FlatSection[] = [];
  let currentLen = 0;
  for (const section of sections) {
    const parts = section.content.length > GIANT_SECTION_LIMIT
      ? splitGiantSection(section)
      : [section];
    for (const part of parts) {
      if (currentLen + part.content.length > BATCH_CHAR_LIMIT && current.length > 0) {
        batches.push(current);
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
  if (current.length > 0) batches.push(current);
  return batches;
}

// chunker-step.ts:679-711 (verbatim)
function buildChunkPrompt(title: string, sections: FlatSection[]): string {
  const sectionTexts = sections
    .map((s) => `---SECTION: ${s.path}---\n${s.content}`)
    .join('\n\n');

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

Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "exact section header from above", "text": "chunk text", "summary": "1-2 sentence summary", "key_concept": "main idea in 3-5 words", "content_type": "methodology", "entities": ["BERT", "SQuAD"], "self_contained": true}, ...]
2. "metadata": {"code_urls": ["https://github.com/..."], "dataset_mentions": ["ImageNet", ...], "benchmark_mentions": ["BLEU", ...]}

For metadata, extract ONLY what is explicitly mentioned in the text above. Return empty arrays if nothing found.`;
}

// Meta-only retry prompt — mirror of backfill-chunk-metadata.ts:308-341
function buildMetaPrompt(title: string, chunks: ChunkJson[]): string {
  const blocks = chunks.map((c, idx) => {
    const section = c.section ?? '(no section)';
    return `[${idx}] DOCUMENT: ${title.slice(0, 200)}
SECTION: ${String(section).slice(0, 200)}
TEXT:
"""
${c.text}
"""`;
  }).join('\n\n');

  return `You are annotating research paper chunks. For each chunk below, classify it and produce concise metadata.

For each chunk return:
- chunk_index: echo the bracketed index from input ([0], [1], ...)
- content_type: one of theoretical, methodology, experimental, results, survey, background, other
- summary: 1-2 sentence summary of what this chunk asserts or describes (max 200 chars)
- key_concept: short phrase capturing the main idea (3-8 words)
- self_contained: true if a reader can understand the chunk without surrounding context, false otherwise
- entities: array of named technical entities mentioned in the chunk (datasets, methods, frameworks, model names, benchmarks). Empty array if none.

Output JSON matching the schema exactly. Return one annotation per input chunk, in the same order.

CHUNKS:

${blocks}`;
}

// ─── Vertex call (mirror of vertex-llm.ts callApi, API-key mode) ───────────

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3.1-pro-preview': { input: 2.5, output: 15 },
};
const FLASH_MODEL = 'gemini-3-flash-preview';
const PRO_MODEL = 'gemini-3.1-pro-preview';
const API_KEY_URL = 'https://aiplatform.googleapis.com/v1/publishers/google/models';

type ThinkingConfig =
  | { thinkingBudget: number }
  | { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' }
  | undefined;

interface VertexCallOptions {
  model: string;
  temperature: number;
  maxOutputTokens: number;
  thinking: ThinkingConfig;
  responseSchema?: unknown;
}

interface VertexCallResult {
  text: string;
  finishReason: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

interface VertexResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

async function callVertex(apiKey: string, prompt: string, opts: VertexCallOptions): Promise<VertexCallResult> {
  const url = `${API_KEY_URL}/${opts.model}:generateContent?key=${apiKey}`;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
  };
  // Only attach thinkingConfig when a variant specifies one. Never set
  // thinkingBudget + thinkingLevel together (API 400).
  if (opts.thinking) generationConfig.thinkingConfig = opts.thinking;
  if (opts.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.responseSchema;
  }

  const t0 = performance.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Vertex AI failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  // Surrogate-sanitize parse — mirror vertex-llm.ts:288-304
  const raw = await resp.text();
  let result: VertexResponse;
  try {
    result = JSON.parse(raw) as VertexResponse;
  } catch {
    const sanitized = raw.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp >= 0xd800 && cp <= 0xdfff ? '\\ufffd' : m;
    });
    result = JSON.parse(sanitized) as VertexResponse;
  }
  const durationMs = Math.round(performance.now() - t0);

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const finishReason = result.candidates?.[0]?.finishReason
    ?? (!result.candidates?.length ? `BLOCKED:${result.promptFeedback?.blockReason ?? 'no_candidates'}` : undefined);
  const inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
  const rates = COST_PER_MILLION[opts.model] ?? { input: 0.5, output: 3 };
  const cost = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  return { text, finishReason, inputTokens, outputTokens, cost, durationMs };
}

// ─── Validation (mirror parseResponse semantics) ───────────────────────────

interface ChunkJson {
  section?: unknown;
  text?: unknown;
  summary?: unknown;
  key_concept?: unknown;
  content_type?: unknown;
  self_contained?: unknown;
  entities?: unknown;
}

function lenientJsonParse(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try { return JSON.parse(cleaned); } catch {
    const sanitized = cleaned.replace(/\\u([0-9a-fA-F]{0,4})/g, (match, hex: string) => {
      if (hex.length !== 4) return '\\\\u' + hex;
      const cp = parseInt(hex, 16);
      if (cp >= 0xd800 && cp <= 0xdfff) return '\\ufffd';
      return match;
    });
    return JSON.parse(sanitized);
  }
}

/**
 * DIAGNOSTIC ONLY — escape-repair: double any backslash that is NOT a valid
 * JSON escape (`\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` `\uXXXX`). This recovers
 * the "Bad escaped character" parse errors (LaTeX `\alpha` etc.), BUT it is
 * UNSAFE for content: `\nu`→newline, `\tau`→tab, `\beta`→backspace,
 * `\frac`→formfeed are silently mis-decoded by JSON.parse. We measure here
 * whether repair (a) parses and (b) leaves control-char corruption, to PROVE
 * it must not be used as the production recovery path.
 */
function repairJsonEscapes(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\/g, (m: string, valid?: string) => (valid ? m : '\\\\'));
}

// Control chars that signal escape-repair corruption of LaTeX commands
// (\b→U+0008 backspace from \beta, \f→U+000C formfeed from \frac).
// (\n/\t corruption from \nu/\tau is invisible — undetectable here.)
const CORRUPTION_RE = /[\u0008\u000c]/;

function isNonEmptyStr(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}
function chunkSplitOk(c: ChunkJson): boolean {
  return isNonEmptyStr(c.section) && isNonEmptyStr(c.text);
}
function chunkMetaOk(c: ChunkJson): boolean {
  return isNonEmptyStr(c.summary)
    && isNonEmptyStr(c.key_concept)
    && typeof c.content_type === 'string'
    && (VALID_CONTENT_TYPES as readonly string[]).includes(c.content_type)
    && typeof c.self_contained === 'boolean';
}

type BatchOutcome = 'ok' | 'meta_gap' | 'split_fail';

interface BatchValidation {
  parseOk: boolean;
  chunkCount: number;
  splitOkCount: number;
  metaOkCount: number;
  invalidContentType: number;
  outcome: BatchOutcome;
  chunks: ChunkJson[];
  parseError?: string;
  // escape-repair diagnostics (set only when the normal parse fails)
  repairParsedOk?: boolean;     // would escape-repair have parsed?
  repairCtrlChars?: number;     // # chunks whose text gained \b/\f control chars (corruption)
}

function validateChunkResponse(text: string, finishReason: string | undefined): BatchValidation {
  const v: BatchValidation = {
    parseOk: false, chunkCount: 0, splitOkCount: 0, metaOkCount: 0,
    invalidContentType: 0, outcome: 'split_fail', chunks: [],
  };
  // MAX_TOKENS (or any non-stop block) → treat as split failure regardless of
  // whatever partial JSON came back; production falls the batch back to pro.
  if (finishReason === 'MAX_TOKENS' || finishReason?.startsWith('BLOCKED:')) {
    v.parseError = `finishReason=${finishReason}`;
    // still try to parse for diagnostics, but outcome stays split_fail
  }
  let parsed: unknown;
  try {
    parsed = lenientJsonParse(text);
  } catch (e) {
    v.parseError = (e as Error).message.slice(0, 200);
    // Diagnostic: would escape-repair have parsed, and does it corrupt text?
    try {
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const repaired = JSON.parse(repairJsonEscapes(cleaned)) as { chunks?: ChunkJson[] };
      v.repairParsedOk = true;
      v.repairCtrlChars = (repaired.chunks ?? []).filter(
        (c) => typeof c.text === 'string' && CORRUPTION_RE.test(c.text),
      ).length;
    } catch {
      v.repairParsedOk = false;
    }
    return v; // split_fail
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return v;
  const chunks = (parsed as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    v.parseError = v.parseError ?? 'no chunks array';
    return v;
  }
  v.parseOk = true;
  v.chunks = chunks as ChunkJson[];
  v.chunkCount = chunks.length;
  for (const c of v.chunks) {
    if (chunkSplitOk(c)) v.splitOkCount++;
    if (chunkMetaOk(c)) v.metaOkCount++;
    if (typeof c.content_type === 'string' && !(VALID_CONTENT_TYPES as readonly string[]).includes(c.content_type)) {
      v.invalidContentType++;
    }
  }
  // Outcome: if a hard finishReason block fired, split_fail. Else if every
  // chunk split OK → either ok (all meta complete) or meta_gap. Else split_fail.
  if (finishReason === 'MAX_TOKENS' || finishReason?.startsWith('BLOCKED:')) {
    v.outcome = 'split_fail';
  } else if (v.splitOkCount === v.chunkCount) {
    v.outcome = v.metaOkCount === v.chunkCount ? 'ok' : 'meta_gap';
  } else {
    v.outcome = 'split_fail';
  }
  return v;
}

function validateMetaAnnotations(text: string, expected: number): { ok: boolean; complete: number; error?: string } {
  let parsed: unknown;
  try { parsed = lenientJsonParse(text); } catch (e) { return { ok: false, complete: 0, error: (e as Error).message.slice(0, 150) }; }
  const arr = (parsed as { annotations?: unknown })?.annotations;
  if (!Array.isArray(arr)) return { ok: false, complete: 0, error: 'annotations not array' };
  let complete = 0;
  for (const a of arr as Array<Record<string, unknown>>) {
    if (isNonEmptyStr(a.summary) && isNonEmptyStr(a.key_concept)
      && typeof a.content_type === 'string' && (VALID_CONTENT_TYPES as readonly string[]).includes(a.content_type)
      && typeof a.self_contained === 'boolean' && Array.isArray(a.entities)) {
      complete++;
    }
  }
  return { ok: arr.length === expected && complete === expected, complete };
}

// ─── Variant matrix ────────────────────────────────────────────────────────

interface Variant {
  id: string;
  label: string;
  schema: boolean;
  thinking: ThinkingConfig;
  temperature: number;
  // SMART RETRY: on split_fail, skip the doomed flash+schema retry (it blows up
  // to MAX_TOKENS on heavy LaTeX) and go STRAIGHT to pro+schema (correct JSON).
  directProOnFail?: boolean;
}

const ALL_VARIANTS: Variant[] = [
  // V0 — current production HEAD (the regression): schema param ON + minimal + temp 0
  { id: 'v0', label: 'schema=ON  think=minimal    temp=0  (current prod)', schema: true,  thinking: { thinkingLevel: 'minimal' }, temperature: 0 },
  // V1 — pre-regression cheap config: schema in prompt only + budget:0 + temp 0
  { id: 'v1', label: 'schema=OFF think=budget:0    temp=0  (pre-regression)', schema: false, thinking: { thinkingBudget: 0 }, temperature: 0 },
  // V2 — pre-regression + max stability (temp 1, Gemini 3 recommended default)
  { id: 'v2', label: 'schema=OFF think=budget:0    temp=1  (cheap+stable)', schema: false, thinking: { thinkingBudget: 0 }, temperature: 1 },
  // V3 — no schema but minimal syntax: isolates thinking-syntax effect w/o schema
  { id: 'v3', label: 'schema=OFF think=minimal     temp=0  (no-schema+minimal)', schema: false, thinking: { thinkingLevel: 'minimal' }, temperature: 0 },
  // V4 — schema ON but budget:0: does budget:0 suppress thinking even WITH schema?
  { id: 'v4', label: 'schema=ON  think=budget:0    temp=0  (schema+budget0)', schema: true,  thinking: { thinkingBudget: 0 }, temperature: 0 },
  // V5 — PROPOSED PRODUCTION FIX: no-schema+temp1 base; on split_fail go straight
  //      to pro+schema (skip the flash+schema blowup). Correct JSON, minimal tax.
  { id: 'v5', label: 'schema=OFF think=budget:0    temp=1  (FIX: direct-pro retry)', schema: false, thinking: { thinkingBudget: 0 }, temperature: 1, directProOnFail: true },
];

// Retry config — the proposed remediation: failed batches retry WITH schema+minimal.
const RETRY_FLASH: VertexCallOptions = {
  model: FLASH_MODEL, temperature: 0, maxOutputTokens: 65536,
  thinking: { thinkingLevel: 'minimal' }, responseSchema: CHUNKER_RESPONSE_SCHEMA,
};
const RETRY_PRO: VertexCallOptions = {
  model: PRO_MODEL, temperature: 0, maxOutputTokens: 65536,
  thinking: { thinkingLevel: 'low' }, responseSchema: CHUNKER_RESPONSE_SCHEMA,
};
const RETRY_META: Omit<VertexCallOptions, 'model'> = {
  temperature: 0, maxOutputTokens: 65536,
  thinking: { thinkingLevel: 'minimal' }, responseSchema: META_RESPONSE_SCHEMA,
};

// ─── Per-variant accumulator ───────────────────────────────────────────────

interface VariantAgg {
  id: string;
  label: string;
  docs: number;
  batches: number;
  // base call
  baseCalls: number;
  baseInTok: number;
  baseOutTok: number;
  baseCost: number;
  baseLatencyMs: number;
  baseOutPerCall: number[];   // for p50/p95
  maxTokensCount: number;
  // batch outcomes (before retry)
  outcomeOk: number;
  outcomeMetaGap: number;
  outcomeSplitFail: number;
  // chunk-level quality (before retry)
  totalChunks: number;
  splitOkChunks: number;
  metaOkChunks: number;
  invalidContentType: number;
  // retries
  metaRetryCalls: number;
  metaRetryInTok: number;
  metaRetryOutTok: number;
  metaRetryCost: number;
  metaRetrySucceeded: number;
  fullRetryFlashCalls: number;
  fullRetryFlashInTok: number;
  fullRetryFlashOutTok: number;
  fullRetryFlashCost: number;
  fullRetryFlashSucceeded: number;
  proRetryCalls: number;
  proRetryInTok: number;
  proRetryOutTok: number;
  proRetryCost: number;
  proRetrySucceeded: number;
  // final quality after retries
  finalResolvedBatches: number;   // batches that ended fully resolved (split+meta) after retries
  errors: number;
}

function newAgg(v: Variant): VariantAgg {
  return {
    id: v.id, label: v.label, docs: 0, batches: 0,
    baseCalls: 0, baseInTok: 0, baseOutTok: 0, baseCost: 0, baseLatencyMs: 0, baseOutPerCall: [], maxTokensCount: 0,
    outcomeOk: 0, outcomeMetaGap: 0, outcomeSplitFail: 0,
    totalChunks: 0, splitOkChunks: 0, metaOkChunks: 0, invalidContentType: 0,
    metaRetryCalls: 0, metaRetryInTok: 0, metaRetryOutTok: 0, metaRetryCost: 0, metaRetrySucceeded: 0,
    fullRetryFlashCalls: 0, fullRetryFlashInTok: 0, fullRetryFlashOutTok: 0, fullRetryFlashCost: 0, fullRetryFlashSucceeded: 0,
    proRetryCalls: 0, proRetryInTok: 0, proRetryOutTok: 0, proRetryCost: 0, proRetrySucceeded: 0,
    finalResolvedBatches: 0, errors: 0,
  };
}

// ─── Doc selection + parse ─────────────────────────────────────────────────

interface DocRow {
  id: string;
  source_id: string;
  title: string;
  sources: { latex?: { path: string; rootTex?: string } } | null;
}

async function selectLatexDocs(limit: number, sourceIds: string[] | null): Promise<DocRow[]> {
  if (sourceIds && sourceIds.length > 0) {
    const r = await query<DocRow>(
      `SELECT id, source_id, title, sources
       FROM documents
       WHERE source_format = 'latex' AND source_id = ANY($1::text[])`,
      [sourceIds],
    );
    return r.rows;
  }
  // Recent latex docs (most likely from the run that showed the regression).
  const r = await query<DocRow>(
    `SELECT id, source_id, title, sources
     FROM documents
     WHERE source_format = 'latex'
       AND sources->'latex'->>'path' IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit * 3], // over-select; filter by eprint-on-disk below
  );
  return r.rows;
}

const stubContext = {
  logger: log,
} as unknown as PipelineContext;

async function parseDoc(doc: DocRow): Promise<{ parsed: ParsedDocument; batches: FlatSection[][] } | null> {
  const latex = doc.sources?.latex;
  if (!latex?.path) return null;
  // Faithfulness gate: the eprint archive must exist (lazy-extract source).
  const eprintPath = join(dirname(latex.path), 'eprint');
  try { await access(eprintPath); } catch { return null; }

  const document = {
    id: doc.id,
    sourceId: doc.source_id,
    title: doc.title,
    sources: { latex: { path: latex.path, rootTex: latex.rootTex } },
    sourceFormat: 'latex' as const,
  } as unknown as Document;

  const strategy = new LatexStrategy();
  const parsed = await strategy.parse(document, stubContext);

  // Mirror chunker-step.ts:337-354 — flatten, filter, batch
  const flat = flattenSections(parsed.sections);
  const nonEmpty = flat.filter((s) => s.content.trim().length > 0);
  const substantive = nonEmpty.filter((s) => s.content.trim().length >= MIN_SECTION_CHARS);
  if (substantive.length === 0) return null;
  const batches = groupIntoBatches(substantive);
  return { parsed, batches };
}

// ─── Run one variant over one doc's batches ────────────────────────────────

interface BatchRecord {
  docId: string;
  sourceId: string;
  variant: string;
  batchIndex: number;
  sections: number;
  promptChars: number;
  baseInTok: number;
  baseOutTok: number;
  baseCost: number;
  baseLatencyMs: number;
  finishReason: string | undefined;
  outcome: BatchOutcome;
  chunkCount: number;
  splitOkCount: number;
  metaOkCount: number;
  invalidContentType: number;
  parseError?: string;
  repairParsedOk?: boolean;
  repairCtrlChars?: number;
  rawHead?: string;            // first chars of raw model output (split_fail only)
  // LaTeX-corruption check on SUCCESSFULLY-PARSED chunks: backslash preservation
  // (output chunk text vs source batch) + control chars. A big backslash drop or
  // any control char = silent LaTeX mangling (\nu→newline etc.).
  srcBackslash?: number;
  outBackslash?: number;
  outCtrlChars?: number;
  retry?: {
    kind: 'meta' | 'full_flash' | 'full_pro';
    inTok: number;
    outTok: number;
    cost: number;
    succeeded: boolean;
  }[];
  finalResolved: boolean;
}

async function runVariantOnDoc(
  apiKey: string,
  variant: Variant,
  doc: DocRow,
  title: string,
  batches: FlatSection[][],
  agg: VariantAgg,
  records: BatchRecord[],
): Promise<void> {
  agg.docs++;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const prompt = buildChunkPrompt(title, batch);
    agg.batches++;

    const rec: BatchRecord = {
      docId: doc.id, sourceId: doc.source_id, variant: variant.id, batchIndex: bi,
      sections: batch.length, promptChars: prompt.length,
      baseInTok: 0, baseOutTok: 0, baseCost: 0, baseLatencyMs: 0,
      finishReason: undefined, outcome: 'split_fail',
      chunkCount: 0, splitOkCount: 0, metaOkCount: 0, invalidContentType: 0,
      retry: [], finalResolved: false,
    };

    let base: VertexCallResult;
    try {
      base = await callVertex(apiKey, prompt, {
        model: FLASH_MODEL,
        temperature: variant.temperature,
        maxOutputTokens: 65536,
        thinking: variant.thinking,
        responseSchema: variant.schema ? CHUNKER_RESPONSE_SCHEMA : undefined,
      });
    } catch (e) {
      agg.errors++;
      rec.parseError = `base_call_error: ${(e as Error).message.slice(0, 150)}`;
      records.push(rec);
      log.warn({ doc: doc.source_id, variant: variant.id, batch: bi, err: rec.parseError }, 'base call failed');
      continue;
    }

    agg.baseCalls++;
    agg.baseInTok += base.inputTokens;
    agg.baseOutTok += base.outputTokens;
    agg.baseCost += base.cost;
    agg.baseLatencyMs += base.durationMs;
    agg.baseOutPerCall.push(base.outputTokens);
    if (base.finishReason === 'MAX_TOKENS') agg.maxTokensCount++;

    rec.baseInTok = base.inputTokens;
    rec.baseOutTok = base.outputTokens;
    rec.baseCost = base.cost;
    rec.baseLatencyMs = base.durationMs;
    rec.finishReason = base.finishReason;

    const val = validateChunkResponse(base.text, base.finishReason);
    rec.outcome = val.outcome;
    rec.chunkCount = val.chunkCount;
    rec.splitOkCount = val.splitOkCount;
    rec.metaOkCount = val.metaOkCount;
    rec.invalidContentType = val.invalidContentType;
    rec.parseError = val.parseError;
    rec.repairParsedOk = val.repairParsedOk;
    rec.repairCtrlChars = val.repairCtrlChars;
    if (val.outcome === 'split_fail') rec.rawHead = base.text.slice(0, 600);

    // Silent-corruption probe on parsed chunks (only meaningful for no-schema).
    if (val.parseOk && val.chunks.length > 0) {
      const countBs = (s: string): number => (s.match(/\\/g) ?? []).length;
      const countCtrl = (s: string): number => (s.match(/[\u0008\u000c]/g) ?? []).length;
      rec.srcBackslash = batch.reduce((n, s) => n + countBs(s.content), 0);
      rec.outBackslash = val.chunks.reduce((n, c) => n + (typeof c.text === 'string' ? countBs(c.text) : 0), 0);
      rec.outCtrlChars = val.chunks.reduce((n, c) => n + (typeof c.text === 'string' ? countCtrl(c.text) : 0), 0);
    }

    agg.totalChunks += val.chunkCount;
    agg.splitOkChunks += val.splitOkCount;
    agg.metaOkChunks += val.metaOkCount;
    agg.invalidContentType += val.invalidContentType;

    if (val.outcome === 'ok') {
      agg.outcomeOk++;
      rec.finalResolved = true;
      records.push(rec);
      continue;
    }

    if (val.outcome === 'meta_gap') {
      agg.outcomeMetaGap++;
      // META-ONLY RETRY — the cost saver. Split succeeded; re-annotate meta only.
      try {
        const metaPrompt = buildMetaPrompt(title, val.chunks);
        const mr = await callVertex(apiKey, metaPrompt, { model: FLASH_MODEL, ...RETRY_META });
        const mv = validateMetaAnnotations(mr.text, val.chunks.length);
        agg.metaRetryCalls++;
        agg.metaRetryInTok += mr.inputTokens;
        agg.metaRetryOutTok += mr.outputTokens;
        agg.metaRetryCost += mr.cost;
        if (mv.ok) { agg.metaRetrySucceeded++; rec.finalResolved = true; }
        rec.retry!.push({ kind: 'meta', inTok: mr.inputTokens, outTok: mr.outputTokens, cost: mr.cost, succeeded: mv.ok });
      } catch (e) {
        agg.errors++;
        rec.parseError = `meta_retry_error: ${(e as Error).message.slice(0, 120)}`;
      }
      records.push(rec);
      continue;
    }

    // split_fail → FULL-BATCH RETRY, then pro.
    //
    // Retry path depends on what the base call already used:
    //  - no-schema variants (V1/V2/V3): the PROPOSED REMEDIATION is to retry
    //    the failed batch WITH schema+minimal on flash; only if that still
    //    fails fall back to pro.
    //  - schema-ON variants (V0/V4): the base call already used schema+minimal,
    //    so a redundant flash schema+minimal retry would just MAX_TOKENS again.
    //    Go STRAIGHT to pro — this matches production (chunker-step.ts:400-410
    //    falls a MAX_TOKENS flash batch directly to gemini-3.1-pro-preview).
    //  - directProOnFail (V5, the proposed FIX): the no-schema failures are
    //    LaTeX JSON-escape errors (finishReason=STOP), NOT truncation. Re-calling
    //    flash+schema just blows up to MAX_TOKENS (wasted 65k out / 171s). Skip it
    //    and go STRAIGHT to pro+schema, which serializes LaTeX with correct escapes.
    agg.outcomeSplitFail++;
    try {
      let resolved = false;
      if (!variant.schema && !variant.directProOnFail) {
        const fr = await callVertex(apiKey, prompt, RETRY_FLASH);
        const fv = validateChunkResponse(fr.text, fr.finishReason);
        agg.fullRetryFlashCalls++;
        agg.fullRetryFlashInTok += fr.inputTokens;
        agg.fullRetryFlashOutTok += fr.outputTokens;
        agg.fullRetryFlashCost += fr.cost;
        resolved = fv.outcome === 'ok';
        if (resolved) agg.fullRetryFlashSucceeded++;
        rec.retry!.push({ kind: 'full_flash', inTok: fr.inputTokens, outTok: fr.outputTokens, cost: fr.cost, succeeded: resolved });
      }

      if (resolved) {
        rec.finalResolved = true;
      } else {
        // pro fallback (production path on persistent MAX_TOKENS)
        const pr = await callVertex(apiKey, prompt, RETRY_PRO);
        const pv = validateChunkResponse(pr.text, pr.finishReason);
        agg.proRetryCalls++;
        agg.proRetryInTok += pr.inputTokens;
        agg.proRetryOutTok += pr.outputTokens;
        agg.proRetryCost += pr.cost;
        const proResolved = pv.outcome === 'ok' || pv.splitOkCount === pv.chunkCount;
        if (proResolved) { agg.proRetrySucceeded++; rec.finalResolved = true; }
        rec.retry!.push({ kind: 'full_pro', inTok: pr.inputTokens, outTok: pr.outputTokens, cost: pr.cost, succeeded: proResolved });
      }
    } catch (e) {
      agg.errors++;
      rec.parseError = `full_retry_error: ${(e as Error).message.slice(0, 120)}`;
    }
    records.push(rec);
  }
}

// ─── CLI + main ────────────────────────────────────────────────────────────

interface Args {
  limit: number;
  variantIds: string[];
  docConcurrency: number;
  out: string;
  sourceIds: string[] | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    limit: parseInt(get('--limit') ?? '10', 10),
    variantIds: (get('--variants') ?? ALL_VARIANTS.map(v => v.id).join(',')).split(',').map(s => s.trim()).filter(Boolean),
    docConcurrency: parseInt(get('--doc-concurrency') ?? '3', 10),
    out: get('--out') ?? '/tmp/chunking-modes',
    sourceIds: get('--source-ids')?.split(',').map(s => s.trim()).filter(Boolean) ?? null,
  };
}

function pct(num: number, den: number): string {
  return den > 0 ? (100 * num / den).toFixed(1) + '%' : 'n/a';
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  const args = parseArgs();
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) { console.error('GOOGLE_AI_API_KEY not set — load .env first'); process.exit(1); }

  const variants = ALL_VARIANTS.filter(v => args.variantIds.includes(v.id));
  if (variants.length === 0) { console.error('no matching variants'); process.exit(1); }

  console.error(`[experiment] selecting LaTeX docs (limit=${args.limit}, sourceIds=${args.sourceIds?.length ?? 'auto'})…`);
  const candidates = await selectLatexDocs(args.limit, args.sourceIds);
  console.error(`[experiment] ${candidates.length} candidate docs; parsing through real LatexStrategy…`);

  // Parse docs (real parser, eprint extract+cleanup). Keep the first `limit`
  // that parse to ≥1 batch.
  const parsedDocs: { doc: DocRow; batches: FlatSection[][]; sections: number }[] = [];
  for (const doc of candidates) {
    if (parsedDocs.length >= args.limit) break;
    try {
      const res = await parseDoc(doc);
      if (!res) { console.error(`  skip ${doc.source_id}: no eprint / no substantive sections`); continue; }
      const totalSections = res.batches.reduce((s, b) => s + b.length, 0);
      parsedDocs.push({ doc, batches: res.batches, sections: totalSections });
      console.error(`  ✓ ${doc.source_id}: ${res.batches.length} batches, ${totalSections} sections`);
    } catch (e) {
      console.error(`  skip ${doc.source_id}: parse error ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (parsedDocs.length === 0) { console.error('no parseable docs'); await pool.end(); process.exit(1); }

  const totalBatches = parsedDocs.reduce((s, d) => s + d.batches.length, 0);
  console.error(`\n[experiment] ${parsedDocs.length} docs, ${totalBatches} batches × ${variants.length} variants = ${totalBatches * variants.length} base calls (+ retries)\n`);

  const aggs = new Map<string, VariantAgg>();
  const records: BatchRecord[] = [];

  // Run each variant fully before the next (clean per-variant cost windows,
  // and avoids interleaving thinking-heavy + cheap calls in the rate path).
  for (const variant of variants) {
    const agg = newAgg(variant);
    aggs.set(variant.id, agg);
    console.error(`\n──── variant ${variant.id}: ${variant.label} ────`);
    // doc-level worker pool
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        if (i >= parsedDocs.length) return;
        const { doc, batches } = parsedDocs[i];
        await runVariantOnDoc(apiKey, variant, doc, doc.title, batches, agg, records);
        process.stderr.write('.');
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, args.docConcurrency) }, () => worker()));
    process.stderr.write('\n');

    // finalResolvedBatches
    agg.finalResolvedBatches = records.filter(r => r.variant === variant.id && r.finalResolved).length;
    printVariant(agg);
  }

  // Write outputs
  await writeFile(`${args.out}-batches.jsonl`, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const summary = [...aggs.values()].map(summarize);
  await writeFile(`${args.out}-summary.json`, JSON.stringify({ docs: parsedDocs.length, totalBatches, variants: summary }, null, 2));
  console.error(`\n[experiment] wrote ${records.length} batch records → ${args.out}-batches.jsonl`);
  console.error(`[experiment] wrote summary → ${args.out}-summary.json`);

  printComparison(summary);
  await pool.end();
}

interface VariantSummary {
  id: string;
  label: string;
  docs: number;
  batches: number;
  avgOutPerCall: number;
  p50OutPerCall: number;
  p95OutPerCall: number;
  maxTokensRate: string;
  avgLatencyMs: number;
  baseCost: number;
  totalCost: number;
  costPerDoc: number;
  splitOkRate: string;
  metaOkRateBase: string;
  finalResolvedRate: string;
  metaRetries: number;
  fullFlashRetries: number;
  proRetries: number;
  errors: number;
}

function summarize(a: VariantAgg): VariantSummary {
  const sorted = [...a.baseOutPerCall].sort((x, y) => x - y);
  const totalCost = a.baseCost + a.metaRetryCost + a.fullRetryFlashCost + a.proRetryCost;
  return {
    id: a.id,
    label: a.label,
    docs: a.docs,
    batches: a.batches,
    avgOutPerCall: a.baseCalls ? Math.round(a.baseOutTok / a.baseCalls) : 0,
    p50OutPerCall: percentile(sorted, 50),
    p95OutPerCall: percentile(sorted, 95),
    maxTokensRate: pct(a.maxTokensCount, a.baseCalls),
    avgLatencyMs: a.baseCalls ? Math.round(a.baseLatencyMs / a.baseCalls) : 0,
    baseCost: +a.baseCost.toFixed(4),
    totalCost: +totalCost.toFixed(4),
    costPerDoc: a.docs ? +(totalCost / a.docs).toFixed(4) : 0,
    splitOkRate: pct(a.splitOkChunks, a.totalChunks),
    metaOkRateBase: pct(a.metaOkChunks, a.totalChunks),
    finalResolvedRate: pct(a.finalResolvedBatches, a.batches),
    metaRetries: a.metaRetryCalls,
    fullFlashRetries: a.fullRetryFlashCalls,
    proRetries: a.proRetryCalls,
    errors: a.errors,
  };
}

function printVariant(a: VariantAgg): void {
  const s = summarize(a);
  console.error(
    `  base: ${a.baseCalls} calls, avg ${s.avgOutPerCall} out/call (p50 ${s.p50OutPerCall}, p95 ${s.p95OutPerCall}), ` +
    `MAX_TOKENS ${s.maxTokensRate}, avg ${s.avgLatencyMs}ms`,
  );
  console.error(`  outcomes: ok=${a.outcomeOk} meta_gap=${a.outcomeMetaGap} split_fail=${a.outcomeSplitFail}`);
  console.error(`  quality(base): split ${s.splitOkRate}, meta ${s.metaOkRateBase}, invalidCT ${a.invalidContentType}`);
  console.error(`  retries: meta ${a.metaRetryCalls}(ok ${a.metaRetrySucceeded}) flash ${a.fullRetryFlashCalls}(ok ${a.fullRetryFlashSucceeded}) pro ${a.proRetryCalls}(ok ${a.proRetrySucceeded})`);
  console.error(`  COST: base $${s.baseCost} + retries → total $${s.totalCost} = $${s.costPerDoc}/doc | final-resolved ${s.finalResolvedRate} | errors ${a.errors}`);
}

function printComparison(rows: VariantSummary[]): void {
  console.error(`\n══════════ COMPARISON ══════════`);
  const header = ['variant', 'out/call', 'p95', 'MAXTOK', 'splitOK', 'metaOK', '$/doc', 'final✓'];
  console.error(header.map(h => h.padEnd(10)).join(''));
  for (const r of rows) {
    console.error([
      r.id.padEnd(10),
      String(r.avgOutPerCall).padEnd(10),
      String(r.p95OutPerCall).padEnd(10),
      r.maxTokensRate.padEnd(10),
      r.splitOkRate.padEnd(10),
      r.metaOkRateBase.padEnd(10),
      ('$' + r.costPerDoc).padEnd(10),
      r.finalResolvedRate.padEnd(10),
    ].join(''));
  }
  console.error(`\nLegend: out/call = avg base output tokens (thinking inflates this); $/doc = base+retry cost;`);
  console.error(`metaOK = % chunks with complete meta from the BASE call (low = needs meta-retry); final✓ = % batches fully resolved after retries.`);
}

main().catch((err) => {
  console.error('[experiment] fatal:', err);
  pool.end().finally(() => process.exit(1));
});
