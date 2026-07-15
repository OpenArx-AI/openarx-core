// ── cycle-label normalization (§12.1, contracts-codified oyq) ────────────────
//
// `run.cycle` is the NUMBER (int) — the filter/sort key; `run.cycle_name` is the
// human-readable display name. The authoritative number↔name mapping is a CONTRACT
// invariant (§12.1); the values are the methodist's cycle taxonomy. A new cycle is a
// coordinated methodology-version event (like the §12.8 relation enums) — never widen
// silently.
//
// ★ 7 is RESERVED (the deterministic-replay axis) — NOT a diagnosable cycle. No run
// should ever stamp 7; a 7 is a BUG, not a valid label. Valid cycle ∈ {1..6, 8, 9}.
//
// Going forward the diagnose-dose emits the NUMBER directly (methodist t473/hxc), so the
// write path just validates+labels it. `normalizeCycle` ALSO parses the legacy mixed forms
// (bare numbers '3'/'4'/'8' and prefixed names 'Cycle 5: Dispute-mapping', 'Review/Integration')
// for the one-time back-fill of existing run nodes — strictly BY THIS TABLE, never guessing
// from free text (an unmappable label returns null → the caller reports it, does not invent one).

export const CYCLE_NAME_BY_NUMBER: Readonly<Record<number, string>> = {
  1: 'Discovery',
  2: 'Verification',
  3: 'Synthesis',
  4: 'Methodology',
  5: 'Dispute-Mapping',
  6: 'Agenda',
  8: 'Engineering',
  9: 'Review/Integration',
};

/** Valid `run.cycle` values — {1..6, 8, 9}. 7 is RESERVED (replay axis), never a real cycle. */
export const VALID_CYCLES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 8, 9]);

const NUMBER_BY_NAME = new Map<string, number>(
  Object.entries(CYCLE_NAME_BY_NUMBER).map(([n, name]) => [name.toLowerCase(), Number(n)]),
);

export interface NormalizedCycle {
  cycle: number;
  cycle_name: string;
}

/**
 * Normalize a raw cycle label (number, numeric string, 'Cycle N: Name', or a bare canonical
 * name) to { cycle: number, cycle_name: string } — STRICTLY by the §12.1 table. Returns null
 * for anything that does not map cleanly (out-of-range, the reserved 7, or an unrecognized
 * label): the caller must report/escalate, NOT invent a value.
 */
export function normalizeCycle(raw: unknown): NormalizedCycle | null {
  if (raw === null || raw === undefined) return null;
  // number or bare numeric string
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw))) {
    const n = typeof raw === 'number' ? raw : parseInt(raw.trim(), 10);
    return VALID_CYCLES.has(n) ? { cycle: n, cycle_name: CYCLE_NAME_BY_NUMBER[n]! } : null;
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // 'Cycle N: Name' / 'Cycle N - Name' → take the number (canonical name from the table)
  const m = s.match(/cycle\s*(\d+)/i);
  if (m) {
    const n = parseInt(m[1]!, 10);
    return VALID_CYCLES.has(n) ? { cycle: n, cycle_name: CYCLE_NAME_BY_NUMBER[n]! } : null;
  }
  // bare canonical name (no 'Cycle N' prefix), e.g. 'Review/Integration'
  const n = NUMBER_BY_NAME.get(s.toLowerCase());
  return n !== undefined ? { cycle: n, cycle_name: CYCLE_NAME_BY_NUMBER[n]! } : null;
}
