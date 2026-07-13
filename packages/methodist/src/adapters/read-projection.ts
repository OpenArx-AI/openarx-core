// ── read-projection adapter (§12.7 · schema-driven · I2) ─────────────────────
//
// I2 (read ≤ written): never read out more than was written. This adapter applies a
// record type's `read` schema block to a record before it leaves the boundary:
//   • strip_fields — keys that are NEVER exposed (recursively removed), e.g. `track_note`.
//   • pointer_when — a gated field returned as a source POINTER, not verbatim, unless the
//     record is distributable. Schema form: { field, unless } — "return `field` verbatim
//     UNLESS `<unless>` is truthy; otherwise a { pointer } to the source."
//
// Pure — no I/O, no ctx. Consumed by the read primitives (read-graph) and the scientific
// read handlers. The request-level field allow-list stays with the caller; this adapter
// enforces the schema-owned strip + distributability gate.

export interface ReadSchema {
  strip_fields?: string[];
  pointer_when?: { field: string; unless: string };
}

export interface ReadProjectionOpts {
  /** record field the pointer resolves from (default `source_uri`). */
  pointerFrom?: string;
}

function stripKeys(value: unknown, strip: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, strip));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (strip.has(k)) continue;
      out[k] = stripKeys(v, strip);
    }
    return out;
  }
  return value;
}

// ── general process-id strip (§12.5-bis · I2) ────────────────────────────────
// A PROCESS field (run_id/intent_id/…) is indexed for internal graph queryability but is
// NEVER agent-facing. This is a GENERAL, name+value rule (independent of any record schema)
// that runs on EVERY agent read path so a denormed process id cannot leak. Mirror of the
// scientific-reads projection rule (kept in sync); used by read-graph. Recursive; drops the
// key entirely (a value pointing at a process node is dropped too).
const SKIP = Symbol('skip');
const PROCESS_ID_KEYS = new Set(['run_id', 'intent_id', 'decision_id', 'stage_id']);
const PROCESS_LABELS = ['run', 'intent', 'decision', 'stage'];
const isProcessIdValue = (v: unknown): boolean => typeof v === 'string' && PROCESS_LABELS.some((l) => v.startsWith(`${l}:`));

function stripValue(key: string, value: unknown): unknown | typeof SKIP {
  if (PROCESS_ID_KEYS.has(key) || key.endsWith('_run_id')) return SKIP;
  if (typeof value === 'string') return isProcessIdValue(value) ? SKIP : value;
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (const item of value) {
      const p = stripValue('', item);
      if (p !== SKIP) arr.push(p);
    }
    return arr;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = stripValue(k, v);
      if (p !== SKIP) out[k] = p;
    }
    return out; // e.g. cycle_context → run_id/stage_id dropped, cycle_type kept
  }
  return value;
}

/** Strip process-node ids from a record (§12.5-bis, general rule). Returns a fresh object. */
export function stripProcessIds(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const p = stripValue(k, v);
    if (p !== SKIP) out[k] = p;
  }
  return out;
}

/** Apply a record type's `read` schema block. Returns a fresh projected object. */
export function applyReadSchema(
  record: Record<string, unknown>,
  schema: ReadSchema | undefined,
  opts: ReadProjectionOpts = {},
): Record<string, unknown> {
  const strip = new Set(schema?.strip_fields ?? []);
  const out = stripKeys(record, strip) as Record<string, unknown>;

  const pw = schema?.pointer_when;
  if (pw) {
    // "unless <field> is truthy": distributable (or explicitly-true gate) → verbatim;
    // otherwise a pointer — the I2-safe default (a missing/false gate never leaks the value).
    const distributable = Boolean(out[pw.unless]);
    if (!distributable) {
      out[pw.field] = { pointer: record[opts.pointerFrom ?? 'source_uri'] ?? null };
    }
  }
  return out;
}
