// ── Generic hash-scope engine (transform) ────────────────────────────────────
//
// `canonicalize` is a GENERIC primitive (framework §1): it must not bake in any
// record-type schema. WHICH fields enter the hash-scope, and the conditional
// keep/drop rules, are supplied as data via `hash_scope` (a platform-standard
// spec owned by the integration layer). This mirrors the platform's
// extractHashScope semantics without importing @openarx:
//   - a field is included only if PRESENT (defined); absent → omitted (§4.3);
//   - `keepOnlyWhen`: the field survives only when the guard matches (e.g.
//     relation.shared_source_uri survives only for relation === 'shared_evidence');
//   - `dropWhen`: the field is stripped when the guard matches (e.g. same_as
//     drops direction/mediator — symmetric identity).

export interface ScopeGuard {
  readonly fields: readonly string[];
  readonly when: { readonly field: string; readonly equals: unknown };
}

export interface HashScope {
  /** ordered field allow-list for this record type */
  readonly include: readonly string[];
  /** fields kept ONLY when their guard matches (else excluded) */
  readonly keepOnlyWhen?: readonly ScopeGuard[];
  /** fields dropped WHEN their guard matches */
  readonly dropWhen?: readonly ScopeGuard[];
}

function excluded(field: string, record: Record<string, unknown>, scope: HashScope): boolean {
  for (const g of scope.keepOnlyWhen ?? []) {
    if (g.fields.includes(field) && record[g.when.field] !== g.when.equals) return true;
  }
  for (const g of scope.dropWhen ?? []) {
    if (g.fields.includes(field) && record[g.when.field] === g.when.equals) return true;
  }
  return false;
}

/** Build the hash-scope object: included, present, non-excluded fields only. */
export function extractScope(record: Record<string, unknown>, scope: HashScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of scope.include) {
    if (excluded(field, record, scope)) continue;
    const value = record[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}
