import { describe, expect, it } from 'vitest';
import { allPrimitives, Registry, type AssignId, type Embed, type LangId } from '../src/index.js';

const assignId: AssignId = (_r, t, p) => `${p}:${t}:x`;
const langId: LangId = async () => ({ lang: 'en', confidence: 1 });
const embed: Embed = () => [0];
const mintId = (c: string) => `run:${c}`;
const now = () => '2026-07-08T00:00:00Z';
const primDeps = { assignId, langId, embed, mintId, now };

describe('allPrimitives', () => {
  it('registers all 35 primitives with no id/version collision', () => {
    const reg = new Registry();
    reg.registerAll(allPrimitives(primDeps));
    const passports = reg.list();
    expect(passports).toHaveLength(35);
    const keys = passports.map((p) => `${p.id}@${p.version}`);
    expect(new Set(keys).size).toBe(35);
  });

  it('covers all 5 categories with the expected counts', () => {
    const reg = new Registry();
    reg.registerAll(allPrimitives(primDeps));
    const counts: Record<string, number> = {};
    for (const p of reg.list()) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    // transform: canonicalize, compute-hash, resolve-local-ids, prepare-context = 4
    // algorithmic 14 (+ route-intent §3.1, + derive-run-status §12.1, + derive-dose §12.1 t5rb) · retrieval 7 (+ fetch-run-path, + fetch-run-closeout §12.1) · state 9 · model-call 1
    expect(counts).toEqual({ transform: 4, algorithmic: 14, retrieval: 7, state: 9, 'model-call': 1 });
  });
});
