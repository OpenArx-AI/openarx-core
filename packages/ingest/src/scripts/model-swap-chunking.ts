/**
 * model-swap-chunking — compare ingest CHUNKING LLMs on a LOCAL 2026 LaTeX corpus.
 *
 * Forks chunking-modes-experiment.ts mechanics (flatten/batch/buildPrompt VERBATIM,
 * chunker-step.ts refs) but: (a) parses a LOCAL extracted-.tex corpus via
 * parseLatexSource (offline, no DB), (b) calls the model via OpenRouter, (c) FIXES the
 * prod baseline generationConfig (schema OFF, thinking minimal, temp 1) and varies the
 * MODEL, (d) applies the REAL prod JSON-fixer (chunker-step repairJsonEscapes/parseChunkJson).
 *
 * Metrics per model (aggregate): format-compliance (valid-JSON-1st-try / repaired / fail),
 * text-preservation (verbatim span %), meta-fill %, chunk-shape (100-500 words, out-of-range),
 * formula-integrity (unbalanced $ / \begin..\end), cost/doc, latency.
 *
 * Usage: cd /home/wlad/Projects/openarx && pnpm --filter @openarx/ingest exec tsx \
 *   src/scripts/model-swap-chunking.ts --models google/gemini-3-flash-preview [--limit 10] [--k 1] [--out <dir>]
 */
import { readdir, readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseLatexSource } from '../parsers/latex-parser.js';
import { repairJsonEscapes, parseChunkJson } from '../pipeline/chunker-step.js';
import type { ParsedSection } from '@openarx/types';

const CORPUS = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/data/corpus';
const KEY = (await readFile('/tmp/claude-1000/-home-wlad-Projects-experimenter-agent/17990a23-f2be-46ef-8c5d-18b1193d2a05/scratchpad/openrouter.key', 'utf-8')).trim();

// ── Mirrored from chunker-step.ts / chunking-modes-experiment.ts (KEEP IN SYNC) ──
const BATCH_CHAR_LIMIT = 3500;
const MIN_SECTION_CHARS = 30;
const GIANT_SECTION_LIMIT = 130_000;
const VALID_CONTENT_TYPES = ['theoretical','methodology','experimental','results','survey','background','other'];

interface FlatSection extends ParsedSection { path: string }
function flattenSections(sections: ParsedSection[], parent = ''): FlatSection[] {
  const out: FlatSection[] = [];
  for (const s of sections) {
    const path = parent ? `${parent} > ${s.name}` : s.name;
    out.push({ ...s, path });
    if (s.subsections?.length) out.push(...flattenSections(s.subsections, path));
  }
  return out;
}
function splitGiant(s: FlatSection): FlatSection[] {
  const paras = s.content.split(/\n\n+/); const parts: FlatSection[] = []; let cur = ''; let idx = 0;
  for (const p of paras) {
    if (cur.length + p.length > GIANT_SECTION_LIMIT && cur.length > 0) {
      parts.push({ ...s, content: cur.trim(), name: `${s.name} [part ${++idx}]`, path: `${s.path} [part ${idx}]` }); cur = p;
    } else cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) parts.push(parts.length ? { ...s, content: cur.trim(), name: `${s.name} [part ${++idx}]`, path: `${s.path} [part ${idx}]` } : { ...s, content: cur.trim() });
  return parts;
}
function groupIntoBatches(sections: FlatSection[]): FlatSection[][] {
  const batches: FlatSection[][] = []; let cur: FlatSection[] = []; let len = 0;
  for (const s of sections) {
    const parts = s.content.length > GIANT_SECTION_LIMIT ? splitGiant(s) : [s];
    for (const part of parts) {
      if (len + part.content.length > BATCH_CHAR_LIMIT && cur.length > 0) {
        batches.push(cur); const last = cur[cur.length - 1];
        if (last.content.length <= 500) { cur = [last]; len = last.content.length; } else { cur = []; len = 0; }
      }
      cur.push(part); len += part.content.length;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}
// chunker-step.ts:679-711 buildPrompt (verbatim)
function buildChunkPrompt(title: string, sections: FlatSection[]): string {
  const sectionTexts = sections.map((s) => `---SECTION: ${s.path}---\n${s.content}`).join('\n\n');
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

// ── OpenRouter call (mirrors openrouter-llm.ts callApi + finish_reason mapping) ──
function mapFinish(raw: string): string {
  const v = (raw || '').toLowerCase();
  if (v === 'stop' || v === 'end_turn' || v === '') return 'STOP';
  if (v === 'length' || v === 'max_tokens') return 'MAX_TOKENS';
  if (v === 'content_filter' || v === 'safety') return 'SAFETY';
  return raw.toUpperCase();
}
interface LlmResult { text: string; finishReason: string; inTok: number; outTok: number; reasonTok: number; cost: number; ms: number; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CALL_TIMEOUT_MS = 90_000;   // abort a hung call (network saturation etc.) instead of waiting forever
const MAX_RETRIES = 3;            // retry timeouts / 5xx / 429 with backoff
async function callOpenRouter(model: string, prompt: string, temperature: number, reasoning?: unknown): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model, messages: [{ role: 'user', content: prompt }],
    temperature, max_tokens: 65536, usage: { include: true },
  };
  // Thinking control: gemini-3.x → {enabled:false} forces 0 thinking (calibrated: valid JSON, ~4s).
  // Instruct/non-thinking (deepseek/qwen/mistral) + gemini-2.5-flash-lite → no param (already 0).
  // NB: reasoning:{effort:low} INDUCES thinking (594 tok, slow) — do NOT use.
  if (reasoning) body.reasoning = reasoning;
  let lastErr: Error = new Error('unreachable');
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
    const t0 = performance.now();
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ac.signal,
      });
      clearTimeout(to);
      const ms = Math.round(performance.now() - t0);
      if (!resp.ok) {
        lastErr = new Error(`OR ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
        if ((resp.status >= 500 || resp.status === 429) && attempt < MAX_RETRIES - 1) { await sleep(2000 * (attempt + 1)); continue; }
        throw lastErr;
      }
      const j = await resp.json() as any;
      const ch = j.choices?.[0];
      const text = ch?.message?.content ?? '';
      const finishReason = mapFinish(ch?.native_finish_reason ?? ch?.finish_reason ?? 'stop');
      const u = j.usage ?? {};
      const inTok = u.prompt_tokens ?? 0, outTok = u.completion_tokens ?? 0;
      const reasonTok = u.completion_tokens_details?.reasoning_tokens ?? 0;
      const cost = typeof u.cost === 'number' ? u.cost : (inTok * 0.5 + outTok * 3) / 1e6;
      return { text, finishReason, inTok, outTok, reasonTok, cost, ms };
    } catch (e) {
      clearTimeout(to);
      lastErr = (e as Error).name === 'AbortError' ? new Error(`timeout>${CALL_TIMEOUT_MS}ms`) : (e as Error);
      if (attempt < MAX_RETRIES - 1) { await sleep(2000 * (attempt + 1)); continue; }
    }
  }
  throw lastErr;   // record as a per-batch error (does NOT hang the run)
}

// ── Parse LLM response via the REAL prod fixer ──
function prodParse(text: string): { chunks: any[] | null; parseOk: boolean; repaired: boolean; error?: string } {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try {
    const { parsed, repaired } = parseChunkJson(cleaned);   // JSON.parse → safe repairJsonEscapes retry (prod path)
    const chunks = (parsed as any)?.chunks;
    if (!Array.isArray(chunks)) return { chunks: null, parseOk: false, repaired, error: 'no chunks array' };
    return { chunks, parseOk: true, repaired };
  } catch (e) { return { chunks: null, parseOk: false, repaired: false, error: (e as Error).message.slice(0, 120) }; }
}

// ── Metrics helpers ──
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const wc = (s: string) => norm(s).split(' ').filter(Boolean).length;
function balancedFormula(t: string): boolean {
  const dollars = (t.match(/(?<!\\)\$/g) ?? []).length;                    // unescaped $ must be even
  const begins = (t.match(/\\begin\{/g) ?? []).length;
  const ends = (t.match(/\\end\{/g) ?? []).length;
  return dollars % 2 === 0 && begins === ends;
}
const isStr = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
function metaOk(c: any): boolean {
  return isStr(c.summary) && isStr(c.key_concept) && typeof c.content_type === 'string'
    && VALID_CONTENT_TYPES.includes(c.content_type) && typeof c.self_contained === 'boolean';
}

interface Agg {
  model: string; docs: number; batches: number; calls: number;
  parseOkFirst: number; repaired: number; parseFail: number; maxTokens: number;
  chunks: number; verbatim: number; metaFilled: number; inRange: number; formulaOk: number; invalidCT: number;
  inTok: number; outTok: number; reasonTok: number; cost: number; ms: number; errors: number;
  wordLens: number[];
}
function newAgg(m: string): Agg {
  return { model: m, docs: 0, batches: 0, calls: 0, parseOkFirst: 0, repaired: 0, parseFail: 0, maxTokens: 0,
    chunks: 0, verbatim: 0, metaFilled: 0, inRange: 0, formulaOk: 0, invalidCT: 0,
    inTok: 0, outTok: 0, reasonTok: 0, cost: 0, ms: 0, errors: 0, wordLens: [] };
}

// ── Progress + throughput logging (tail -f the progress log to watch live) ──
const PROGRESS_LOG = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/results/progress.log';
let CALLS_DONE = 0;
const RUN_T0 = performance.now();
async function logProgress(line: string): Promise<void> {
  const mins = (performance.now() - RUN_T0) / 60000;
  const rpm = mins > 0 ? (CALLS_DONE / mins).toFixed(1) : '0.0';
  const msg = `[+${mins.toFixed(1)}m ${CALLS_DONE} calls ${rpm} req/min] ${line}\n`;
  process.stderr.write(msg);
  try { await appendFile(PROGRESS_LOG, msg); } catch { /* ignore */ }
}

// ── Crash-safe incremental append: serialize writes through one chain so concurrent
//    workers never interleave lines. Chunks land on disk per-batch, not per-model —
//    a stop/crash mid-model keeps every paid batch (lesson: near-done run must not lose work). ──
let writeChain: Promise<void> = Promise.resolve();
function appendRowsSafe(file: string, rows: any[]): Promise<void> {
  if (!rows.length) return writeChain;
  const data = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeChain = writeChain.then(() => appendFile(file, data)).catch(() => { /* disk hiccup: don't kill the run */ });
  return writeChain;
}

// ── Sliding-concurrency pool: ramp workers up with a 1s stagger to CONCURRENCY,
//    then each worker grabs the next item the instant its slot frees (sliding limit). ──
const CONCURRENCY = 10;
const RAMP_MS = 1000;
async function runPool<T>(items: T[], concurrency: number, rampMs: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(startDelay: number): Promise<void> {
    if (startDelay) await sleep(startDelay);   // ramp: worker k starts after k*1s → gradual fill
    while (true) {
      const i = next++;                        // shared cursor (atomic in single-thread event loop)
      if (i >= items.length) return;
      try { await fn(items[i]); } catch { /* fn records its own errors */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_, k) => worker(k * rampMs)));
}

async function loadCorpus(limit: number): Promise<{ id: string; title: string; batches: FlatSection[][] }[]> {
  const ids = (await readdir(CORPUS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
  const docs: { id: string; title: string; batches: FlatSection[][] }[] = [];
  for (const id of ids) {
    if (docs.length >= limit) break;
    let title = id;
    try { title = JSON.parse(await readFile(join(CORPUS, id, 'metadata.json'), 'utf-8')).title ?? id; } catch { /* fallback id */ }
    try {
      const parsed = await parseLatexSource(join(CORPUS, id));
      const flat = flattenSections(parsed.sections).filter(s => s.content.trim().length >= MIN_SECTION_CHARS);
      if (!flat.length) { console.error(`  skip ${id}: no substantive sections`); continue; }
      const batches = groupIntoBatches(flat);
      docs.push({ id, title, batches });
      console.error(`  ✓ ${id}: ${batches.length} batches, ${flat.length} sections`);
    } catch (e) { console.error(`  skip ${id}: parse err ${(e as Error).message.slice(0, 100)}`); }
  }
  return docs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  const models = (get('--models') ?? 'google/gemini-3-flash-preview').split(',').map(s => s.trim());
  const limit = parseInt(get('--limit') ?? '10', 10);
  const k = parseInt(get('--k') ?? '1', 10);
  const concurrency = parseInt(get('--concurrency') ?? String(CONCURRENCY), 10);
  const outDir = get('--out') ?? '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/results';
  await mkdir(outDir, { recursive: true });
  const chunksDir = join(outDir, 'chunks');   // per-model dump of the FINAL (post-repair) chunks
  await mkdir(chunksDir, { recursive: true });

  console.error(`[model-swap] loading local corpus (limit=${limit})…`);
  const docs = await loadCorpus(limit);
  const totalBatches = docs.reduce((s, d) => s + d.batches.length, 0);
  console.error(`[model-swap] ${docs.length} docs, ${totalBatches} batches × ${models.length} models × k=${k}\n`);

  // dump batch SOURCES once (model-independent) → offline verbatim/granularity comparison vs the original text
  const srcRows = docs.flatMap((doc) => doc.batches.map((b, bi) => ({
    id: doc.id, bi, sections: b.map((s) => s.path),
    words: wc(b.map((s) => s.content).join('\n')), source: b.map((s) => s.content).join('\n'),
  })));
  await writeFile(join(outDir, 'batch-sources.jsonl'), srcRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const aggs: Agg[] = []; const records: any[] = [];
  const summaryPath = join(outDir, 'chunking-smoke-summary.json');
  // periodic partial-summary flush (incl. the in-flight model) so a mid-model stop still leaves a fresh aggregate
  const savePartial = (cur: Agg) => writeFile(summaryPath,
    JSON.stringify({ docs: docs.length, totalBatches, partial: true, models: [...aggs, cur].map(summarize) }, null, 2)).catch(() => {});
  for (const model of models) {
    const agg = newAgg(model);
    // FINAL post-repair chunks for this model → appended per-batch (crash-safe) for offline re-analysis / cross-model diff
    const chunkFile = join(chunksDir, `${model.replace(/[/:]/g, '__')}.jsonl`);
    await writeFile(chunkFile, '');   // truncate fresh per model
    const reasoning = /gemini/.test(model) ? { enabled: false } : undefined;   // disable thinking for the whole Gemini family (2.5/3.x)
    console.error(`──── model ${model} (schema OFF, thinking=${reasoning ? 'disabled' : 'default-off'}, temp 1) ────`);
    // work items: every (rep, doc, batch) = one LLM call → run through the sliding-concurrency pool
    const items: { doc: (typeof docs)[number]; bi: number; rep: number }[] = [];
    for (let rep = 0; rep < k; rep++) for (const doc of docs) for (let bi = 0; bi < doc.batches.length; bi++) items.push({ doc, bi, rep });
    agg.docs = docs.length * k;
    await runPool(items, concurrency, RAMP_MS, async ({ doc, bi, rep }) => {
      const batch = doc.batches[bi];
      const prompt = buildChunkPrompt(doc.title, batch);
      const srcNorm = norm(batch.map(s => s.content).join('\n'));
      agg.batches++;
      let r: LlmResult;
      try { r = await callOpenRouter(model, prompt, 1, reasoning); }
      catch (e) { agg.errors++; await logProgress(`! ${doc.id} b${bi}: ${(e as Error).message.slice(0, 90)}`); return; }
      CALLS_DONE++;
      agg.calls++; agg.inTok += r.inTok; agg.outTok += r.outTok; agg.reasonTok += r.reasonTok; agg.cost += r.cost; agg.ms += r.ms;
      if (r.finishReason === 'MAX_TOKENS') agg.maxTokens++;
      const p = prodParse(r.text);
      if (!p.parseOk) {
        agg.parseFail++; records.push({ model, id: doc.id, rep, bi, parse: 'fail', err: p.error, finish: r.finishReason });
        if (agg.calls % 10 === 0) await logProgress(`${model}: ${agg.calls}/${items.length}`);
        return;
      }
      if (p.repaired) agg.repaired++; else agg.parseOkFirst++;
      const batchChunks: any[] = [];
      p.chunks!.forEach((c: any, ci: number) => {
        agg.chunks++;
        const txt = typeof c.text === 'string' ? c.text : '';
        const verbatim = !!(txt && srcNorm.includes(norm(txt)));         // verbatim span of source
        if (verbatim) agg.verbatim++;
        const mok = metaOk(c); if (mok) agg.metaFilled++;
        const w = wc(txt); agg.wordLens.push(w); if (w >= 100 && w <= 500) agg.inRange++;
        const fok = balancedFormula(txt); if (fok) agg.formulaOk++;
        if (typeof c.content_type === 'string' && !VALID_CONTENT_TYPES.includes(c.content_type)) agg.invalidCT++;
        // persist the FINAL chunk (post-repair) so we can compare models later without re-calling any LLM
        batchChunks.push({
          id: doc.id, rep, bi, ci, section: c.section, words: w,
          verbatim, metaOk: mok, formulaOk: fok, content_type: c.content_type,
          key_concept: c.key_concept, summary: c.summary, entities: c.entities,
          self_contained: c.self_contained, text: txt,
        });
      });
      await appendRowsSafe(chunkFile, batchChunks);   // durable per-batch — survives a mid-model stop
      records.push({ model, id: doc.id, rep, bi, parse: p.repaired ? 'repaired' : 'ok', chunks: p.chunks!.length, finish: r.finishReason, outTok: r.outTok, reasonTok: r.reasonTok });
      if (agg.calls % 10 === 0) await logProgress(`${model}: ${agg.calls}/${items.length} calls`);
    });
    aggs.push(agg); printAgg(agg);
    await writeChain;   // ensure every per-batch chunk append is flushed to disk
    // incremental summary save after EACH model — paid work is never lost on stop/crash
    await writeFile(join(outDir, 'chunking-smoke-summary.json'),
      JSON.stringify({ docs: docs.length, totalBatches, partial: true, models: aggs.map(summarize) }, null, 2));
    await logProgress(`═══ model ${model} DONE — ${agg.chunks} chunks saved → ${chunkFile}`);
  }
  const summary = aggs.map(summarize);
  await writeFile(join(outDir, 'chunking-smoke-summary.json'), JSON.stringify({ docs: docs.length, totalBatches, models: summary }, null, 2));
  await writeFile(join(outDir, 'chunking-smoke-records.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.error(`\n[model-swap] wrote results → ${outDir}/chunking-smoke-{summary.json,records.jsonl}`);
  console.error(`[model-swap] final chunks → ${chunksDir}/<model>.jsonl · batch sources → ${outDir}/batch-sources.jsonl`);
}
function pct(n: number, d: number) { return d > 0 ? (100 * n / d).toFixed(1) + '%' : 'n/a'; }
function summarize(a: Agg) {
  const sorted = [...a.wordLens].sort((x, y) => x - y);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    model: a.model, docs: a.docs, batches: a.batches, calls: a.calls, errors: a.errors,
    format: { validFirst: pct(a.parseOkFirst, a.calls), repaired: pct(a.repaired, a.calls), fail: pct(a.parseFail, a.calls), maxTokens: pct(a.maxTokens, a.calls) },
    chunks: a.chunks,
    textPreservation: pct(a.verbatim, a.chunks),
    metaFill: pct(a.metaFilled, a.chunks),
    chunkShape: { inRange_100_500: pct(a.inRange, a.chunks), medWords: med },
    formulaIntegrity: pct(a.formulaOk, a.chunks),
    invalidContentType: a.invalidCT,
    avgOutTok: a.calls ? Math.round(a.outTok / a.calls) : 0,
    avgReasonTok: a.calls ? Math.round(a.reasonTok / a.calls) : 0,
    avgLatencyMs: a.calls ? Math.round(a.ms / a.calls) : 0,
    costPerDoc: a.docs ? +(a.cost / a.docs).toFixed(4) : 0,
    totalCost: +a.cost.toFixed(4),
  };
}
function printAgg(a: Agg) {
  const s = summarize(a);
  console.error(`  format: validFirst ${s.format.validFirst}, repaired ${s.format.repaired}, fail ${s.format.fail}, MAX_TOKENS ${s.format.maxTokens}`);
  console.error(`  quality: text-verbatim ${s.textPreservation}, meta-fill ${s.metaFill}, in-range(100-500w) ${s.chunkShape.inRange_100_500} (med ${s.chunkShape.medWords}w), formula-integrity ${s.formulaIntegrity}, invalidCT ${s.invalidContentType}`);
  console.error(`  tokens: out ${s.avgOutTok}/call (reasoning ${s.avgReasonTok}), latency ${s.avgLatencyMs}ms, COST $${s.costPerDoc}/doc (total $${s.totalCost}), errors ${a.errors}`);
}
main().catch((e) => { console.error('[model-swap] fatal:', e); process.exit(1); });
