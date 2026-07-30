/**
 * marker-e4 — E4 for beads experimenter_agent-vcw (baseline only).
 * Question D2: can baseline emit MARKERS instead of full chunk text? Does segmentation change vs
 * full-text? Token savings? One BASE prompt (real prod buildPrompt), three output modes:
 *   full       — chunk.text (+ fields)               [reference]
 *   anchors    — chunk.start_anchor/end_anchor (verbatim first/last ~8 words) (+ fields)
 *   charoffset — chunk.start_char/end_char into the shown source (+ fields)   [control, likely fails]
 * Dumps raw model output + token usage + the exact batch source → results/e4/<mode>.jsonl.
 *
 * Usage: cd /home/wlad/Projects/openarx && pnpm --filter @openarx/ingest exec tsx \
 *   src/scripts/marker-e4.ts --modes full,anchors,charoffset --limit 3 --out <dir>
 */
import { readdir, readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseLatexSource } from '../parsers/latex-parser.js';
import type { ParsedSection } from '@openarx/types';

const CORPUS = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/data/corpus';
const KEY = (await readFile('/tmp/claude-1000/-home-wlad-Projects-experimenter-agent/17990a23-f2be-46ef-8c5d-18b1193d2a05/scratchpad/openrouter.key', 'utf-8')).trim();
const MODEL = 'google/gemini-3-flash-preview';
const BATCH_CHAR_LIMIT = 3500, MIN_SECTION_CHARS = 30, GIANT = 130_000;
const TEMP = process.argv.includes('--temp') ? parseFloat(process.argv[process.argv.indexOf('--temp') + 1]) : 1;

interface Flat extends ParsedSection { path: string }
function flatten(sections: ParsedSection[], parent = ''): Flat[] {
  const out: Flat[] = [];
  for (const s of sections) {
    const path = parent ? `${parent} > ${s.name}` : s.name;
    out.push({ ...s, path });
    if (s.subsections?.length) out.push(...flatten(s.subsections, path));
  }
  return out;
}
function batches(sections: Flat[]): Flat[][] {
  const bs: Flat[][] = []; let cur: Flat[] = [], len = 0;
  for (const s of sections) {
    if (s.content.length > GIANT) continue;                 // skip giant (rare); E4 not about those
    if (len + s.content.length > BATCH_CHAR_LIMIT && cur.length) {
      bs.push(cur); const last = cur[cur.length - 1];
      if (last.content.length <= 500) { cur = [last]; len = last.content.length; } else { cur = []; len = 0; }
    }
    cur.push(s); len += s.content.length;
  }
  if (cur.length) bs.push(cur);
  return bs;
}
const sectionText = (b: Flat[]) => b.map((s) => `---SECTION: ${s.path}---\n${s.content}`).join('\n\n');
const rawContent = (b: Flat[]) => b.map((s) => s.content).join('\n');

// shared preamble (real prod buildPrompt structure) up to the field spec
function preamble(title: string, b: Flat[]): string {
  return `Split the following paper sections into semantic units.
Each unit = one complete thought/claim/concept. Preserve original text exactly.
Target 100-500 words per chunk. Keep formulas with their explanations.

CRITICAL chunking rules:
- Every chunk MUST end at a complete sentence boundary. Never cut a sentence in the middle.
- For LaTeX source: do NOT split inside \\begin{...}...\\end{...} environments, math blocks ($...$, \\[...\\]), figure/table captions, or \\item lists. Keep these atomic — include the full environment in one chunk.
- Each chunk MUST belong to exactly ONE section. Never combine text from different sections into one chunk.
- For "section", use the EXACT section header as shown (including any ">" hierarchy).

CRITICAL: For EVERY chunk you MUST populate ALL of the following fields. Do NOT omit any required field.

1. summary (REQUIRED, string): 1-2 sentences capturing the core claim.
2. key_concept (REQUIRED, string): the main idea in 3-5 words.
3. content_type (REQUIRED, enum): exactly one of "theoretical","methodology","experimental","results","survey","background","other".
4. entities (array of strings): named entities — method/dataset/metric proper names only. Empty [] acceptable.
5. self_contained (REQUIRED, boolean): true if standalone.

Document: "${title}"
Sections:
${sectionText(b)}
`;
}

function buildFull(title: string, b: Flat[]): string {
  return preamble(title, b) + `
Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "...", "text": "<full verbatim chunk text>", "summary": "...", "key_concept": "...", "content_type": "methodology", "entities": [], "self_contained": true}, ...]
2. "metadata": {"code_urls": [], "dataset_mentions": [], "benchmark_mentions": []}
For metadata, extract ONLY what is explicitly mentioned. Return empty arrays if nothing found.`;
}

function buildAnchors(title: string, b: Flat[]): string {
  return preamble(title, b) + `
Do NOT return the full chunk text. Instead, for each chunk return ONLY its BOUNDARY MARKERS:
- "start_anchor": the FIRST 8 words of the unit, copied EXACTLY (verbatim) from the source above.
- "end_anchor": the LAST 8 words of the unit, copied EXACTLY (verbatim) from the source above.
Copy anchors character-for-character from the source (same punctuation, LaTeX, math). Do NOT paraphrase or normalize.

Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "...", "start_anchor": "<first 8 words verbatim>", "end_anchor": "<last 8 words verbatim>", "summary": "...", "key_concept": "...", "content_type": "methodology", "entities": [], "self_contained": true}, ...]
2. "metadata": {"code_urls": [], "dataset_mentions": [], "benchmark_mentions": []}`;
}

function buildCharoffset(title: string, b: Flat[]): string {
  // provide the raw concatenated content with explicit 0-based indexing note
  return preamble(title, b) + `
Do NOT return the full chunk text. Instead, for each chunk return the CHARACTER OFFSETS of its span
within the exact SECTION content shown above (0-based; start inclusive, end exclusive), counting every
character including spaces and newlines:
- "start_char": integer offset where the unit begins.
- "end_char": integer offset where the unit ends.

Return ONLY a JSON object with two keys:
1. "chunks": [{"section": "...", "start_char": 0, "end_char": 512, "summary": "...", "key_concept": "...", "content_type": "methodology", "entities": [], "self_contained": true}, ...]
2. "metadata": {"code_urls": [], "dataset_mentions": [], "benchmark_mentions": []}`;
}

const BUILD: Record<string, (t: string, b: Flat[]) => string> = { full: buildFull, anchors: buildAnchors, charoffset: buildCharoffset };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(prompt: string): Promise<{ text: string; inTok: number; outTok: number; cost: number; ms: number }> {
  const body = { model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: TEMP, max_tokens: 65536, usage: { include: true }, reasoning: { enabled: false } };
  for (let att = 0; att < 3; att++) {
    const t0 = performance.now();
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!resp.ok) { if (resp.status >= 500 || resp.status === 429) { await sleep(2000 * (att + 1)); continue; } throw new Error(`OR ${resp.status}`); }
      const j = await resp.json() as any;
      const u = j.usage ?? {};
      return { text: j.choices?.[0]?.message?.content ?? '', inTok: u.prompt_tokens ?? 0, outTok: u.completion_tokens ?? 0, cost: u.cost ?? 0, ms: Math.round(performance.now() - t0) };
    } catch (e) { if (att === 2) throw e; await sleep(2000 * (att + 1)); }
  }
  throw new Error('unreachable');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
  const modes = (get('--modes') ?? 'full,anchors,charoffset').split(',');
  const limit = parseInt(get('--limit') ?? '3', 10);
  const out = get('--out') ?? '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/results/e4';
  await mkdir(out, { recursive: true });

  const ids = (await readdir(CORPUS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().slice(0, limit);
  const docs: { id: string; title: string; batches: Flat[][] }[] = [];
  for (const id of ids) {
    let title = id;
    try { title = JSON.parse(await readFile(join(CORPUS, id, 'metadata.json'), 'utf-8')).title ?? id; } catch { /* */ }
    const parsed = await parseLatexSource(join(CORPUS, id));
    const flat = flatten(parsed.sections).filter((s) => s.content.trim().length >= MIN_SECTION_CHARS);
    docs.push({ id, title, batches: batches(flat) });
    console.error(`  ${id}: ${batches(flat).length} batches`);
  }

  const CONC = parseInt(get('--concurrency') ?? '12', 10);
  for (const mode of modes) {
    const file = join(out, `${mode}.jsonl`);
    await writeFile(file, '');
    const items: { doc: (typeof docs)[number]; bi: number }[] = [];
    for (const doc of docs) for (let bi = 0; bi < doc.batches.length; bi++) items.push({ doc, bi });
    let tout = 0, tcost = 0, n = 0, done = 0, next = 0, writeChain: Promise<void> = Promise.resolve();
    async function worker(delay: number): Promise<void> {
      if (delay) await sleep(delay);
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        const { doc, bi } = items[i]; const b = doc.batches[bi];
        let r; try { r = await call(BUILD[mode](doc.title, b)); } catch { console.error(`  ! ${doc.id} b${bi} failed`); continue; }
        tout += r.outTok; tcost += r.cost; n++; done++;
        const row = JSON.stringify({ id: doc.id, bi, mode, sections: b.map((s) => s.path), content: rawContent(b), sectionText: sectionText(b), raw: r.text, inTok: r.inTok, outTok: r.outTok, cost: r.cost, ms: r.ms }) + '\n';
        writeChain = writeChain.then(() => appendFile(file, row));   // serialized append (no interleave)
        if (done % 25 === 0) console.error(`  [${mode}] ${done}/${items.length} ($${tcost.toFixed(2)})`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, (_, k) => worker(k * 300)));
    await writeChain;
    console.error(`═══ mode ${mode}: ${n}/${items.length} calls, avg out ${Math.round(tout / n)} tok, total $${tcost.toFixed(4)} ($${(tcost / docs.length).toFixed(4)}/doc)`);
  }
  console.error(`[marker-e4] wrote → ${out}/<mode>.jsonl`);
}
main().catch((e) => { console.error('[marker-e4] fatal:', e); process.exit(1); });
