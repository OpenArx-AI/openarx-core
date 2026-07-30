// ── redact-fields v1 (transform · deterministic) ─────────────────────────────
//
// goal: return a COPY of a submission with the prose VALUES at the given field-paths
// replaced by presence-markers — for the closeout VERDICT-INPUT only (bead
// openarx-mbtx; contracts ruling s4ez "CLOSEOUT VERDICT-INPUT PROSE-REDACTION",
// §125-adjacent).
//
// WHY: on version_closeout the submission carries content.deliverable_document = the
// full human-facing prose (genre/title/section_outline/sections:{[name]: prose}). That
// makes the verdict model-call (prepare-context → call-model, checkpoint step[7]→[8])
// long enough to hold the StreamableHTTP connection past a client-side idle-timeout
// ("transport dropped mid-call"; size-correlated). The closeout verdict ATTESTS
// deliverable presence + genre-structure + completeness (section_outline ↔
// Object.keys(sections)); it does NOT re-grade the human-facing prose (methodist 0602).
// So the verdict-input copy can drop the prose bodies while KEEPING KEYS.
//
// ★ §4.3-identity invariant (contracts s4ez): this is a pure copy-on-write transform —
// it NEVER mutates its input. The wiring feeds the REDACTED copy to the verdict
// prepare-context (step[7]) ONLY; the RAW submission still flows to resolve-local-ids →
// write-graph-records, so record-identity / content-hashes derive from the FULL persisted
// prose (0 data-loss). A redaction reaching the hashed path would be §9.2-catastrophic.
//
// Generic + path-driven (no dose field hard-coded): params.paths is a list of dotted
// field-paths; a `key[]` segment descends into an array and applies the rest of the path
// to each element. A missing/typed-wrong segment → no-op pass-through (contracts-blessed:
// safe on non-closeout submissions, which lack deliverable_document). presence-marker
// preserves a size signal so verdict still sees "non-empty".
// params: { paths: string[] } · in: { submission } · out: { submission } (redacted copy)
// access/effects: none.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

interface Params {
  paths: string[];
}
interface In {
  submission?: unknown;
}
interface Out {
  submission: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Replace a single prose leaf with a presence-marker that preserves a size signal. */
function markerLeaf(v: unknown): unknown {
  if (typeof v === 'string') return `[prose omitted: ${v.length} chars]`;
  if (Array.isArray(v)) return `[omitted: ${v.length} items]`;
  if (v != null && typeof v === 'object') return '[object omitted]';
  return v; // number/boolean/null: negligible, keep the value/signal
}

/** Redact the path TIP: a map → KEEP KEYS, marker each value; a bare leaf → marker it. */
function redactTip(node: unknown): unknown {
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(node)) out[k] = markerLeaf(val);
    return out;
  }
  return markerLeaf(node);
}

/** Copy-on-write walk to `segments`; returns node UNCHANGED (same ref) when the path is absent. */
function redactAtPath(node: unknown, segments: string[]): unknown {
  if (segments.length === 0) return redactTip(node);
  const [seg, ...rest] = segments;
  const isArrayWild = seg.endsWith('[]');
  const key = isArrayWild ? seg.slice(0, -2) : seg;
  if (!isPlainObject(node) || !(key in node)) return node; // path-absent → no-op
  const child = node[key];
  let newChild: unknown;
  if (isArrayWild) {
    if (!Array.isArray(child)) return node; // shape mismatch → no-op
    newChild = child.map((el) => redactAtPath(el, rest));
  } else {
    newChild = redactAtPath(child, rest);
  }
  return { ...node, [key]: newChild }; // copy-on-write: the input object is never mutated
}

export const redactFieldsPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'redact-fields',
    version: 'v1',
    kind: 'transform',
    goal: 'copy a submission with prose values at given field-paths replaced by presence-markers (verdict-input only)',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const paths = params.paths;
    // A malformed `paths` param is a dose/config error — fail loud (regress catches it)
    // rather than silently skipping redaction and reintroducing the transport-drop.
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
      throw new RuntimeError('bad-output', 'redact-fields: params.paths must be a string[]');
    }
    let submission = inputs.submission;
    for (const path of paths) {
      const segments = path.split('.').filter((s) => s.length > 0);
      submission = redactAtPath(submission, segments);
    }
    return { outputs: { submission } };
  },
);
