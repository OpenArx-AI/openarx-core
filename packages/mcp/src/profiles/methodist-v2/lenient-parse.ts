// ── S6(1)/S6(3) checkpoint-payload lenient-parse (contracts "CHECKPOINT PAYLOAD LENIENT-PARSE
// RULING", batch-3) ──────────────────────────────────────────────────────────────────────────
//
// A client that JSON-STRINGIFIES the checkpoint payload (or a nested submission/records) is
// tolerated (Postel) — parse the string then validate as today — while a genuinely-malformed string
// still fails LOUD + diagnosably (bad-output, NOT silent-accept, NOT throw). SCOPE: the checkpoint
// door only (payload + nested submission/records).
//
// ★ abvc-A idempotency invariant: the caller runs this BEFORE the server-derived submission_hash, so
// the hash is computed over the PARSED object → an object input and a json-string of the SAME object
// yield an IDENTICAL hash (§2g replay preserved). A NATIVE object/array is returned UNCHANGED (the
// existing downstream validation still runs — semantics identical to the object path; we never
// re-shape a native value). Size is bounded by the existing express.json(80mb) envelope.

export type LenientResult = { ok: true; value: unknown } | { ok: false; reason: string; message: string };

/**
 * Leniently coerce a value that may be a JSON string into its parsed form.
 *   - native (non-string): returned as-is (shape validated downstream, unchanged semantics).
 *   - string: JSON.parsed; a non-JSON string → `<field>_unparseable`; a parse to the wrong shape
 *     (`expect`) → `<field>_not_<object|array>` — a deterministic bad-output fail-loud (S6(3)).
 */
export function lenientJson(value: unknown, field: string, expect: 'object' | 'array'): LenientResult {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return {
        ok: false,
        reason: `${field}_unparseable`,
        message: `${field} was received as a string that is not valid JSON. Send ${field} as a JSON ${expect}, not a stringified/escaped string.`,
      };
    }
    const okShape = expect === 'array' ? Array.isArray(v) : v != null && typeof v === 'object' && !Array.isArray(v);
    if (!okShape) {
      return {
        ok: false,
        reason: `${field}_not_${expect}`,
        message: `${field} was received as a string that did not parse to a JSON ${expect}. Send ${field} as a ${expect}.`,
      };
    }
  }
  return { ok: true, value: v };
}
