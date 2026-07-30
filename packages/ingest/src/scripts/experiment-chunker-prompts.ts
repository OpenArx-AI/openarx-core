/**
 * experiment-chunker-prompts — lab experiment for openarx-dlv6.
 *
 * Standalone. Does NOT modify production chunker. Loads real sections from
 * PG (chunks.content from existing null-meta and populated chunks), then
 * runs them through 5 prompt/schema variants against Gemini Vertex and
 * tabulates field-fill rates per variant.
 *
 * Goal: find prompt + structured-output schema configuration that drives
 * meta-field-population from ~70% (current baseline) to ≥95% without
 * regressing on quality (no garbage filler) or breaking JSON parsing.
 *
 * Usage:
 *   pnpm --filter @openarx/ingest exec tsx \
 *     src/scripts/experiment-chunker-prompts.ts \
 *     [--sample-size N] [--variants v0,v1,v2,v3] [--out /tmp/chunker-exp.json]
 *
 * Required env: GOOGLE_AI_API_KEY (Gemini API). Reads from .env.
 *
 * Output JSON report to /tmp/chunker-experiment-report.json by default.
 */

import { writeFile } from 'node:fs/promises';
import { pool, query } from '@openarx/api';

// ── Constants ───────────────────────────────────────────────

const VALID_CONTENT_TYPES = new Set([
  'theoretical', 'methodology', 'experimental', 'results', 'survey', 'background', 'abstract', 'other',
]);

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

// ── Prompt builders ─────────────────────────────────────────

interface Section { name: string; content: string; }

function buildBaselinePrompt(title: string, sections: Section[]): string {
  // Replicates chunker-step.ts:buildPrompt verbatim.
  const sectionTexts = sections.map((s) => `---SECTION: ${s.name}---\n${s.content}`).join('\n\n');
  return `Split the following paper sections into semantic units.
Each unit = one complete thought/claim/concept. Preserve original text exactly.
Target 100-500 words per chunk. Keep formulas with their explanations.
CRITICAL: Every chunk MUST end at a complete sentence boundary. Never cut a sentence in the middle — always include the full sentence ending with a period, question mark, or other terminal punctuation.
For LaTeX source: do not split inside \\begin{...}...\\end{...} environments, math blocks ($...$, \\[...\\]), figure/table captions, or \\item lists. Keep these atomic — include the full environment in one chunk.
For each chunk, provide:
- summary: 1-2 sentences capturing the core claim.
- key_concept: the main idea in 3-5 words.
- content_type: one of "theoretical", "methodology", "experimental", "results", "survey", "background", "other".
- entities: array of key named entities mentioned in this chunk — method names (e.g. "BERT", "LoRA"), dataset names (e.g. "ImageNet", "SQuAD"), metric names (e.g. "BLEU", "F1"). Only proper names, not generic terms like "neural network".
- self_contained: true if this chunk can be understood on its own without reading previous chunks, false if it depends on prior context.
CRITICAL: Each chunk MUST belong to exactly ONE section. Never combine text from different sections into one chunk. If a section boundary falls mid-thought, end the chunk at the boundary and start a new chunk in the next section.
For "section", use the EXACT section header as shown (including any ">" hierarchy).

Document: "${title}"
Sections:
${sectionTexts}

Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "exact section header from above", "text": "chunk text", "summary": "1-2 sentence summary", "key_concept": "main idea in 3-5 words", "content_type": "methodology", "entities": ["BERT", "SQuAD"], "self_contained": true}, ...]
2. "metadata": {"code_urls": ["https://github.com/..."], "dataset_mentions": ["ImageNet", ...], "benchmark_mentions": ["BLEU", ...]}`;
}

function buildTightenedPrompt(title: string, sections: Section[]): string {
  // V1: same as baseline but with MUST markers on meta fields + explicit
  // guidance for math-only content. We also remove the soft "For each chunk,
  // provide" wording in favor of a numbered MUST list.
  const sectionTexts = sections.map((s) => `---SECTION: ${s.name}---\n${s.content}`).join('\n\n');
  return `Split the following paper sections into semantic units.
Each unit = one complete thought/claim/concept. Preserve original text exactly.
Target 100-500 words per chunk. Keep formulas with their explanations.

CRITICAL chunking rules:
- Every chunk MUST end at a complete sentence boundary.
- For LaTeX source: do not split inside \\begin{...}...\\end{...} environments, math blocks ($...$, \\[...\\]), figure/table captions, or \\item lists.
- Each chunk MUST belong to exactly ONE section.

CRITICAL: For EVERY chunk you MUST populate ALL of the following fields. Do NOT omit any field. Do NOT return empty strings unless the chunk is genuinely empty of that information.

1. summary (REQUIRED, string): 1-2 sentences capturing the core claim. For pure-formula chunks, summarize what the formula expresses (e.g. "Defines the loss function used during training").
2. key_concept (REQUIRED, string): the main idea in 3-5 words. For pure-formula chunks, name the formula or concept (e.g. "cross-entropy loss", "diffusion equation").
3. content_type (REQUIRED, enum): exactly one of "theoretical", "methodology", "experimental", "results", "survey", "background", "other". Use "theoretical" for proofs and derivations. Use "other" only as last resort.
4. entities (REQUIRED, array of strings): named entities mentioned — method names (e.g. "BERT", "LoRA"), dataset names ("ImageNet", "SQuAD"), metric names ("BLEU", "F1"). Empty array [] is acceptable when no proper names appear, but the array itself MUST be present.
5. self_contained (REQUIRED, boolean): true if this chunk can be understood standalone, false if it depends on prior context.

For "section", use the EXACT section header as shown (including any ">" hierarchy).

Document: "${title}"
Sections:
${sectionTexts}

Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "exact section header from above", "text": "chunk text", "summary": "1-2 sentence summary", "key_concept": "main idea in 3-5 words", "content_type": "methodology", "entities": ["BERT", "SQuAD"], "self_contained": true}, ...]
2. "metadata": {"code_urls": ["https://github.com/..."], "dataset_mentions": ["ImageNet", ...], "benchmark_mentions": ["BLEU", ...]}`;
}

// ── Variants ────────────────────────────────────────────────

interface VariantSpec {
  id: string;
  description: string;
  buildPrompt: (title: string, sections: Section[]) => string;
  useSchema: boolean;
}

const VARIANTS: VariantSpec[] = [
  { id: 'v0_baseline', description: 'current prompt, no schema', buildPrompt: buildBaselinePrompt, useSchema: false },
  { id: 'v1_tight_prompt', description: 'tightened prompt only', buildPrompt: buildTightenedPrompt, useSchema: false },
  { id: 'v2_schema_only', description: 'current prompt + responseSchema', buildPrompt: buildBaselinePrompt, useSchema: true },
  { id: 'v3_tight_and_schema', description: 'tightened + responseSchema', buildPrompt: buildTightenedPrompt, useSchema: true },
];

// ── Gemini Vertex caller ────────────────────────────────────

interface ChunkResp {
  section?: string;
  text?: string;
  summary?: string;
  key_concept?: string;
  content_type?: string;
  entities?: unknown;
  self_contained?: unknown;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  useSchema: boolean,
): Promise<{ raw: string; finishReason: string; inputTokens: number; outputTokens: number }> {
  // Same Vertex AI endpoint used by production VertexLlm (api_key mode).
  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${apiKey}`;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: 65536,
    temperature: 0,
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (useSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = CHUNKER_RESPONSE_SCHEMA;
  }
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
    throw new Error(`Gemini API ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  return {
    raw: candidate?.content?.parts?.[0]?.text ?? '',
    finishReason: candidate?.finishReason ?? 'UNKNOWN',
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function parseChunks(raw: string): ChunkResp[] | null {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj.chunks)) return obj.chunks as ChunkResp[];
    return null;
  } catch {
    return null;
  }
}

// ── Per-chunk evaluation ────────────────────────────────────

interface ChunkEval {
  hasSummary: boolean;
  hasKeyConcept: boolean;
  hasValidContentType: boolean;
  hasEntitiesField: boolean;
  hasSelfContained: boolean;
  allPresent: boolean;
  contentTypeRaw: string | null;
  summaryLen: number;
  fillerLike: boolean;
}

const FILLER_PATTERNS = [
  /^no summary$/i, /^n\/?a$/i, /^unknown$/i, /^none$/i, /^summary$/i,
  /^placeholder$/i, /^todo$/i, /^empty$/i, /^not (specified|available|applicable)$/i,
];

function evalChunk(c: ChunkResp): ChunkEval {
  const sumStr = typeof c.summary === 'string' ? c.summary.trim() : '';
  const kcStr = typeof c.key_concept === 'string' ? c.key_concept.trim() : '';
  const ctStr = typeof c.content_type === 'string' ? c.content_type.trim() : '';
  const ctValid = !!ctStr && VALID_CONTENT_TYPES.has(ctStr);
  const hasSelfContained = typeof c.self_contained === 'boolean';
  const fillerSum = FILLER_PATTERNS.some((p) => p.test(sumStr));
  const fillerKc = FILLER_PATTERNS.some((p) => p.test(kcStr));
  return {
    hasSummary: sumStr.length > 0,
    hasKeyConcept: kcStr.length > 0,
    hasValidContentType: ctValid,
    hasEntitiesField: Array.isArray(c.entities),
    hasSelfContained,
    allPresent: sumStr.length > 0 && kcStr.length > 0 && ctValid && hasSelfContained,
    contentTypeRaw: ctStr || null,
    summaryLen: sumStr.length,
    fillerLike: fillerSum || fillerKc,
  };
}

// ── Section sampler ─────────────────────────────────────────

interface SampleSection { id: string; documentId: string; title: string; sectionPath: string; content: string; originalContextNull: boolean; }

async function loadSamples(targetSize: number): Promise<SampleSection[]> {
  // Mix: 60% from null-meta chunks (the problem), 30% from populated chunks
  // (control — verify we don't regress), 10% from math-heavy null chunks.
  const nullPlainN = Math.floor(targetSize * 0.6);
  const populatedN = Math.floor(targetSize * 0.3);
  const mathN = targetSize - nullPlainN - populatedN;

  const nullPlainQ = `
    SELECT c.id, c.document_id, d.title, c.section_path, c.content, true AS original_context_null
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.position > 0 AND c.is_latest = true
      AND (c.context->>'contentType') IS NULL
      AND (c.context->>'summary') IS NULL
      AND content !~ E'\\\\begin\\{(eqnarray|equation|align|cases|array|proof|lemma|theorem|definition|corollary|proposition)'
      AND content !~ '\\$\\$'
      AND length(c.content) BETWEEN 200 AND 3000
    ORDER BY random() LIMIT $1
  `;
  const populatedQ = `
    SELECT c.id, c.document_id, d.title, c.section_path, c.content, false AS original_context_null
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.position > 0 AND c.is_latest = true
      AND (c.context->>'contentType') IS NOT NULL
      AND length(c.content) BETWEEN 200 AND 3000
    ORDER BY random() LIMIT $1
  `;
  const mathQ = `
    SELECT c.id, c.document_id, d.title, c.section_path, c.content, true AS original_context_null
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.position > 0 AND c.is_latest = true
      AND (c.context->>'contentType') IS NULL
      AND (content ~ E'\\\\begin\\{(eqnarray|equation|align|cases|array|proof|lemma|theorem)' OR content ~ '\\$\\$')
      AND length(c.content) BETWEEN 100 AND 3000
    ORDER BY random() LIMIT $1
  `;

  const [nullPlain, populated, math] = await Promise.all([
    query<SampleSection>(nullPlainQ, [nullPlainN]),
    query<SampleSection>(populatedQ, [populatedN]),
    query<SampleSection>(mathQ, [mathN]),
  ]);

  return [
    ...nullPlain.rows.map((r: any) => ({ ...r, documentId: r.document_id, sectionPath: r.section_path, originalContextNull: r.original_context_null })),
    ...populated.rows.map((r: any) => ({ ...r, documentId: r.document_id, sectionPath: r.section_path, originalContextNull: r.original_context_null })),
    ...math.rows.map((r: any) => ({ ...r, documentId: r.document_id, sectionPath: r.section_path, originalContextNull: r.original_context_null })),
  ];
}

// ── Main ────────────────────────────────────────────────────

interface VariantAggregate {
  variant: string;
  description: string;
  samples: number;
  chunksReturned: number;
  parseOk: number;
  apiErrors: number;
  allFieldsPresent: number;
  hasSummary: number;
  hasKeyConcept: number;
  hasValidContentType: number;
  hasEntitiesField: number;
  hasSelfContained: number;
  fillerLike: number;
  avgSummaryLen: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  contentTypeDist: Record<string, number>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let sampleSize = 70;
  let variantFilter: string[] | null = null;
  let outPath = '/tmp/chunker-experiment-report.json';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--sample-size') { sampleSize = parseInt(args[++i], 10); }
    else if (a === '--variants') { variantFilter = args[++i].split(','); }
    else if (a === '--out') { outPath = args[++i]; }
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_AI_API_KEY env var required');
    process.exit(1);
  }
  const model = 'gemini-2.5-flash';
  const variants = variantFilter
    ? VARIANTS.filter((v) => variantFilter!.includes(v.id))
    : VARIANTS;

  console.error(`[exp] sample-size=${sampleSize} variants=${variants.map(v=>v.id).join(',')} model=${model}`);

  console.error('[exp] loading samples from PG...');
  const samples = await loadSamples(sampleSize);
  console.error(`[exp] loaded ${samples.length} sample sections`);

  const results: VariantAggregate[] = [];
  for (const variant of variants) {
    console.error(`\n[exp] ── variant ${variant.id} — ${variant.description}`);
    const agg: VariantAggregate = {
      variant: variant.id,
      description: variant.description,
      samples: 0, chunksReturned: 0, parseOk: 0, apiErrors: 0,
      allFieldsPresent: 0, hasSummary: 0, hasKeyConcept: 0,
      hasValidContentType: 0, hasEntitiesField: 0, hasSelfContained: 0,
      fillerLike: 0, avgSummaryLen: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalDurationMs: 0,
      contentTypeDist: {},
    };
    let summaryLenSum = 0;

    // Group samples into batches mimicking production chunker (BATCH_CHAR_LIMIT=3500).
    // Sections from same doc grouped together (title pinned per-batch from first sample).
    const BATCH_CHAR_LIMIT = 3500;
    const batches: SampleSection[][] = [];
    let current: SampleSection[] = [];
    let currentLen = 0;
    for (const s of samples) {
      if (currentLen + s.content.length > BATCH_CHAR_LIMIT && current.length > 0) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(s);
      currentLen += s.content.length;
    }
    if (current.length > 0) batches.push(current);
    console.error(`[exp] ${variant.id}: ${batches.length} batches across ${samples.length} samples`);

    for (const batch of batches) {
      agg.samples += batch.length;
      const title = batch[0].title;
      const sectionsForPrompt: Section[] = batch.map(s => ({ name: s.sectionPath, content: s.content }));
      const prompt = variant.buildPrompt(title, sectionsForPrompt);
      const t0 = Date.now();
      try {
        const { raw, inputTokens, outputTokens } = await callGemini(apiKey, model, prompt, variant.useSchema);
        agg.totalDurationMs += Date.now() - t0;
        agg.totalInputTokens += inputTokens;
        agg.totalOutputTokens += outputTokens;

        const chunks = parseChunks(raw);
        if (chunks === null) { continue; }
        agg.parseOk++;
        agg.chunksReturned += chunks.length;
        for (const c of chunks) {
          const e = evalChunk(c);
          if (e.allPresent) agg.allFieldsPresent++;
          if (e.hasSummary) agg.hasSummary++;
          if (e.hasKeyConcept) agg.hasKeyConcept++;
          if (e.hasValidContentType) agg.hasValidContentType++;
          if (e.hasEntitiesField) agg.hasEntitiesField++;
          if (e.hasSelfContained) agg.hasSelfContained++;
          if (e.fillerLike) agg.fillerLike++;
          summaryLenSum += e.summaryLen;
          if (e.contentTypeRaw) {
            agg.contentTypeDist[e.contentTypeRaw] = (agg.contentTypeDist[e.contentTypeRaw] ?? 0) + 1;
          }
        }
      } catch (err) {
        agg.apiErrors++;
        console.error(`[exp] api error batch (first sample=${batch[0].id}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    agg.avgSummaryLen = agg.chunksReturned > 0 ? Math.round(summaryLenSum / agg.chunksReturned) : 0;
    console.error(`[exp] ${variant.id}: chunks=${agg.chunksReturned} all-present=${agg.allFieldsPresent} (${agg.chunksReturned > 0 ? Math.round(100 * agg.allFieldsPresent / agg.chunksReturned) : 0}%) parseErrors=${agg.samples - agg.parseOk - agg.apiErrors} apiErrors=${agg.apiErrors}`);
    results.push(agg);
  }

  await writeFile(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    model,
    sampleSize,
    samplesLoaded: samples.length,
    results,
  }, null, 2));

  console.error(`\n[exp] report written to ${outPath}`);
  console.error('\n=== Summary ===');
  console.error(`${'variant'.padEnd(24)} ${'all%'.padStart(6)} ${'sum%'.padStart(6)} ${'kc%'.padStart(6)} ${'ct%'.padStart(6)} ${'sc%'.padStart(6)} ${'filler%'.padStart(8)} ${'avgSumLen'.padStart(10)}`);
  for (const r of results) {
    const pct = (n: number) => r.chunksReturned > 0 ? Math.round(100 * n / r.chunksReturned).toString() : '0';
    console.error(`${r.variant.padEnd(24)} ${pct(r.allFieldsPresent).padStart(6)} ${pct(r.hasSummary).padStart(6)} ${pct(r.hasKeyConcept).padStart(6)} ${pct(r.hasValidContentType).padStart(6)} ${pct(r.hasSelfContained).padStart(6)} ${pct(r.fillerLike).padStart(8)} ${r.avgSummaryLen.toString().padStart(10)}`);
  }
}

main().catch((err) => {
  console.error('[exp] fatal:', err);
  process.exit(1);
}).finally(() => pool.end());
