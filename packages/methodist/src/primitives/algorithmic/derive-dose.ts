// ── derive-dose v1 (algorithmic · deterministic · read-view) ─────────────────
//
// §12.1 (openarx-t5rb): the per-(cycle,stage) dose is DETERMINISTIC — a lookup in the
// `dose_by_cycle_stage` table (methodist _process SoT), NOT an LLM expansion (which varied per
// ward = the reproducibility bug + the source of the stored-dose lag). Derive-on-read: no per-run
// dose is stored, so nothing falls stale (matches §12.1-bis "run.status derived, not stored").
//
// The table is keyed by the INTERNAL `current_stage` integer (contracts-pinned): for c2–c9 the
// §D stage label N maps to key "N"; c1 is 0-indexed in §D but keyed by current_stage 1–7 — the +1
// offset is BAKED INTO the table keys (the methodist authored c1 cells at 1–7), so this primitive
// applies NO offset. c7 is reserved (absent from the table) → a miss.
//
// in: { cycle, current_stage } · params: { dose_by_cycle_stage } · access/effects: none.
// out: { found, dose? }. found:false ⇒ the caller keeps the current generation path (fallback,
// incremental rollout). Under complete-table-first every in-range (cycle,stage) cell is authored,
// so a miss is an out-of-range stage (done-view) or an unknown/reserved cycle — no dose, by design.

import { definePrimitive, type Registration } from '../../runtime/index.js';

export interface DoseCell {
  operations?: unknown;
  beacons?: unknown;
  counters?: unknown;
  expected_artifacts?: unknown;
}
interface Params {
  /** methodist _process SoT table: { "c<N>": { "<current_stage>": DoseCell } } (de-ref'd from
   *  the FRAME like record_schema / hash_scope). Absent ⇒ every lookup misses (fallback). */
  dose_by_cycle_stage?: Record<string, Record<string, DoseCell>>;
}
interface In {
  /** the run's diagnosed cycle (integer ∈ {1..6,8,9}; 7 reserved). Accepts number or numeric string. */
  cycle?: number | string;
  /** the run's authoritative current_stage integer — the table key (already offset for c1). */
  current_stage?: number | string;
}
interface Out {
  found: boolean;
  dose?: Record<string, unknown>;
}

/** Canonical integer key from a number or a numeric string; null for anything else (so a bad
 *  cycle/stage misses cleanly rather than keying on garbage). */
function intKey(v: unknown): string | null {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return String(parseInt(v.trim(), 10));
  return null;
}

/** Pure (cycle, current_stage) → dose lookup, shared by the `derive-dose` primitive AND
 *  `update-run-state` (Model U write-through projection, §12.1 t5rb). Emits the FULL field-set +
 *  the stage (insight A: complete {operations,beacons,counters,expected_artifacts} at every stage,
 *  fixing the checkpoint operations-only drop). Defensive defaults so a partial cell never yields
 *  `undefined`. found:false ⇒ no dose (done / out-of-range / unknown-or-reserved cycle). */
export function deriveDose(
  cycle: unknown,
  currentStage: unknown,
  table: Record<string, Record<string, DoseCell>> | undefined,
): Out {
  const cycleKey = intKey(cycle);
  const stageKey = intKey(currentStage);
  if (!table || cycleKey === null || stageKey === null) return { found: false };
  const cell = table[`c${cycleKey}`]?.[stageKey];
  if (!cell || typeof cell !== 'object') return { found: false };
  const c = cell as DoseCell;
  return {
    found: true,
    dose: {
      operations: c.operations ?? [],
      beacons: c.beacons ?? [],
      counters: c.counters ?? [],
      expected_artifacts: c.expected_artifacts ?? [],
      stage: Number(stageKey),
    },
  };
}

export const deriveDosePrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'derive-dose',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'derive the (cycle,current_stage) dose by deterministic lookup in dose_by_cycle_stage (§12.1); no LLM expansion, no stored per-run dose',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => ({
    outputs: deriveDose(inputs.cycle, inputs.current_stage, (params ?? {}).dose_by_cycle_stage),
  }),
);
