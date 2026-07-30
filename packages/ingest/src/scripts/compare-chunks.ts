/**
 * compare-chunks — side-by-side ACTUAL chunk text from two models on the SAME section.
 * Usage: tsx src/scripts/compare-chunks.ts [docId] [modelA] [modelB]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLatexSource } from '../parsers/latex-parser.js';
import { parseChunkJson } from '../pipeline/chunker-step.js';
import type { ParsedSection } from '@openarx/types';

const KEY = (await readFile('/tmp/claude-1000/-home-wlad-Projects-experimenter-agent/17990a23-f2be-46ef-8c5d-18b1193d2a05/scratchpad/openrouter.key', 'utf-8')).trim();
const CORPUS = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/data/corpus';

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
const wc = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;

function buildPrompt(title: string, sections: Flat[]): string {
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

1. summary (REQUIRED, string): 1-2 sentences capturing the core claim.
2. key_concept (REQUIRED, string): the main idea in 3-5 words.
3. content_type (REQUIRED, enum): one of "theoretical","methodology","experimental","results","survey","background","other".
4. entities (array of strings): named entities. Empty array [] acceptable.
5. self_contained (REQUIRED, boolean).

Document: "${title}"
Sections:
${sectionTexts}

Return ONLY a JSON object with keys "chunks" (array of {section,text,summary,key_concept,content_type,entities,self_contained}) and "metadata" ({code_urls,dataset_mentions,benchmark_mentions}).`;
}

// REFINED prompt — reframes the unit as a semantically-coherent passage (NOT per-sentence),
// says nothing about word count. Fixes the "one sentence = one chunk" over-splitting.
function buildPromptRefined(title: string, sections: Flat[]): string {
  const sectionTexts = sections.map((s) => `---SECTION: ${s.path}---\n${s.content}`).join('\n\n');
  return `Split the following paper sections into semantic units.

What a unit IS: a run of CONSECUTIVE sentences that together develop ONE idea, result, method step, or argument and read as a self-contained passage. A claim MUST stay together with the sentences that set it up, explain it, quantify it, give evidence for it, or interpret it — the setup, the observation, and its interpretation of the SAME result belong in ONE unit.

What a unit is NOT: a single isolated sentence. Do NOT start a new unit at every sentence. Start a NEW unit ONLY when the text genuinely moves to a DIFFERENT idea / result / step / argument. When several sentences elaborate the same point, KEEP THEM TOGETHER as one unit. If you are unsure whether the next sentence continues the same idea, keep it in the same unit.

Preserve the original text exactly. Keep formulas with their explanations.

CRITICAL chunking rules:
- Every unit MUST end at a complete sentence boundary. Never cut a sentence mid-way.
- For LaTeX source: do NOT split inside \\begin{...}...\\end{...} environments, math blocks ($...$, \\[...\\]), figure/table captions, or \\item lists.
- Each unit belongs to exactly ONE section. Use the EXACT section header as shown.

For EVERY unit populate ALL fields:
1. summary (1-2 sentences, the core claim).
2. key_concept (main idea, 3-5 words).
3. content_type (one of "theoretical","methodology","experimental","results","survey","background","other").
4. entities (named entities; [] acceptable).
5. self_contained (boolean).

Document: "${title}"
Sections:
${sectionTexts}

Return ONLY a JSON object with keys "chunks" (array of {section,text,summary,key_concept,content_type,entities,self_contained}) and "metadata" ({code_urls,dataset_mentions,benchmark_mentions}).`;
}

async function call(model: string, prompt: string, temperature = 1): Promise<any[]> {
  const body: any = { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: 65536, usage: { include: true } };
  if (/gemini-3/.test(model)) body.reasoning = { enabled: false };
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await resp.json() as any;
  let text = (j.choices?.[0]?.message?.content ?? '').trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try { const { parsed } = parseChunkJson(text); return (parsed as any)?.chunks ?? []; } catch { return []; }
}

const docId = process.argv[2] ?? '2601.00499';
const modelA = process.argv[3] ?? 'google/gemini-3-flash-preview';
const modelB = process.argv[4] ?? 'qwen/qwen3-30b-a3b-instruct-2507';

const parsed = await parseLatexSource(join(CORPUS, docId));
const flat = flatten(parsed.sections).filter((s) => s.content.trim().length >= 30);
// pick a mid-size section (200-700 words) → best to see the granularity difference
const cand = flat.map((s) => ({ s, w: wc(s.content) })).filter((x) => x.w >= 150 && x.w <= 700).sort((a, b) => a.w - b.w);
const section = (cand[Math.floor(cand.length / 2)] ?? { s: flat.sort((a, b) => wc(b.content) - wc(a.content))[0], w: 0 }).s;
console.log(`\n════════ DOC ${docId} · SECTION "${section.path}" (${wc(section.content)} words) ════════\n`);
console.log(`SOURCE (first 500 chars):\n${section.content.slice(0, 500).replace(/\n/g, ' ')}…\n`);

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const oldP = buildPrompt(parsed.title ?? docId, [section]);
const refP = buildPromptRefined(parsed.title ?? docId, [section]);
const configs = [
  { label: `${modelA} · OLD prompt · temp=1 (baseline reference)`, model: modelA, prompt: oldP, temp: 1 },
  { label: `${modelB} · OLD prompt · temp=0 (deterministic)`, model: modelB, prompt: oldP, temp: 0 },
  { label: `${modelB} · REFINED prompt · temp=0 (deterministic)`, model: modelB, prompt: refP, temp: 0 },
];
for (const cfg of configs) {
  const chunks = await call(cfg.model, cfg.prompt, cfg.temp);
  const ws = chunks.map((c: any) => wc(typeof c.text === 'string' ? c.text : ''));
  console.log(`\n──────── ${cfg.label}: ${chunks.length} chunks (median ${median(ws)}w) ────────`);
  chunks.forEach((c: any, i: number) => {
    const t = typeof c.text === 'string' ? c.text : '';
    console.log(`  [${i}] ${wc(t)}w · ${c.content_type} · key="${c.key_concept}"`);
    console.log(`      text: ${t.replace(/\s+/g, ' ').slice(0, 180)}${t.length > 180 ? '…' : ''}`);
  });
}
