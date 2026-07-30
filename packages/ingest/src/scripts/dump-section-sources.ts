/** Dump per-section sources for the 100-doc corpus (offline parse, no LLM) → section_sources.jsonl
 * {id, path, content}. Used to validate recoverSequence at PER-SECTION granularity (Core Q1). */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLatexSource } from '../parsers/latex-parser.js';
import type { ParsedSection } from '@openarx/types';

const CORPUS = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/data/corpus';
const OUT = '/home/wlad/Projects/experimenter_agent/projects/ingest_llm_selection/code/section_sources.jsonl';
const MIN = 30;

function flatten(sections: ParsedSection[], parent = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const s of sections) {
    const path = parent ? `${parent} > ${s.name}` : s.name;
    out.push({ path, content: s.content });
    if (s.subsections?.length) out.push(...flatten(s.subsections, path));
  }
  return out;
}

const ids = (await readdir(CORPUS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().slice(0, 100);
const lines: string[] = [];
for (const id of ids) {
  try {
    const parsed = await parseLatexSource(join(CORPUS, id));
    for (const s of flatten(parsed.sections)) {
      if (s.content.trim().length >= MIN) lines.push(JSON.stringify({ id, path: s.path, content: s.content }));
    }
  } catch (e) { console.error(`skip ${id}: ${(e as Error).message.slice(0, 80)}`); }
}
await writeFile(OUT, lines.join('\n') + '\n');
console.error(`wrote ${lines.length} sections → ${OUT}`);
