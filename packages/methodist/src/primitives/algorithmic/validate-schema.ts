// ── validate-schema v1 (algorithmic · deterministic) ─────────────────────────
//
// goal: validate a record against (base schema ⊕ methodology overlay).
// in: { record }, params: { base_schema, overlay? } · out: { valid, errors[] } · access/effects: none.
// A small structural validator (type / required / nested properties) — enough for
// the base+cycle-overlay merge; NOT a full JSON Schema engine. base_schema and
// overlay are methodology-provided (framework "explicitly declared by the methodology").

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';
import { asRecordArray } from '../shared.js';

/** Injected platform capability: per-type MENTEE content-shape validator → error messages
 *  ([] = valid). When present, validate-schema enforces it fail-closed (throws on malformed). */
export type ValidateShape = (record: unknown, recordType: string) => string[];

export interface MiniSchema {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, MiniSchema>;
}

function jsType(v: unknown): MiniSchema['type'] {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return undefined;
}

/** overlay overrides base type and unions required + properties (cycle overlay). */
export function mergeSchema(base: MiniSchema, overlay?: MiniSchema): MiniSchema {
  if (!overlay) return base;
  const props: Record<string, MiniSchema> = { ...(base.properties ?? {}) };
  for (const [k, sub] of Object.entries(overlay.properties ?? {})) {
    props[k] = mergeSchema(base.properties?.[k] ?? {}, sub);
  }
  return {
    type: overlay.type ?? base.type,
    required: [...new Set([...(base.required ?? []), ...(overlay.required ?? [])])],
    properties: props,
  };
}

function validate(value: unknown, schema: MiniSchema, path: string, errors: string[]): void {
  if (schema.type && jsType(value) !== schema.type) {
    errors.push(`${path || '$'}: expected ${schema.type}, got ${jsType(value)}`);
    return;
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path ? path : '$'}.${req}: required`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) validate(obj[k], sub, `${path ? path + '.' : ''}${k}`, errors);
    }
  }
}

interface In {
  /** single record (unit tests) OR a records array / wrapper (checkpoint publish). */
  record?: unknown;
  records?: unknown;
}
interface Params {
  /** resolved by the interpreter from schema_ref; absent → nothing to validate. */
  base_schema?: MiniSchema;
  overlay?: MiniSchema;
}
interface Out {
  valid: boolean;
  errors: string[];
}

/**
 * validate-schema. When the platform's real per-type shape validator is INJECTED
 * (integration), a malformed record (e.g. a flat, non-content-wrapped claim) THROWS
 * bad-output — it never reaches the id/write path (openarx-xpfz fail-closed enforcement;
 * well-formedness is frame-integrity per §1-bis, NOT methodology, so the methodist cannot
 * disable it). Without the validator (unit tests / non-record validation) it falls back to
 * the structural mini-schema (base ⊕ overlay), returning { valid, errors } as before.
 */
export function makeValidateSchema(validateShape?: ValidateShape): Registration {
  return definePrimitive<Params, In, Out>(
    {
      id: 'validate-schema',
      version: 'v1',
      kind: 'algorithmic',
      goal: 'validate a record against base schema merged with a methodology overlay',
      access: [],
      effects: [],
      determinism: 'deterministic',
    },
    ({ inputs, params }) => {
      // Fail-closed frame-integrity enforcement: real per-type shape validator + records present.
      if (validateShape && inputs.records !== undefined) {
        const errors: string[] = [];
        asRecordArray(inputs.records).forEach((r, i) => {
          const entry = r as { record_type?: unknown; record?: unknown };
          const type = typeof entry.record_type === 'string' ? entry.record_type : 'claim';
          for (const msg of validateShape(entry.record ?? r, type)) errors.push(`records[${i}] (${type}): ${msg}`);
        });
        if (errors.length > 0) throw new RuntimeError('bad-output', `schema_invalid: ${errors.join('; ')}`);
        return { outputs: { valid: true, errors: [] } };
      }
      // Fallback structural mini-schema (base ⊕ overlay) — no injected validator.
      if (!params.base_schema) return { outputs: { valid: true, errors: [] } }; // no spec resolved → nothing to check
      const schema = mergeSchema(params.base_schema, params.overlay);
      const errors: string[] = [];
      if (inputs.record !== undefined) {
        validate(inputs.record, schema, '', errors);
      } else {
        asRecordArray(inputs.records).forEach((r, i) => validate((r as { record?: unknown }).record ?? r, schema, `records[${i}]`, errors));
      }
      return { outputs: { valid: errors.length === 0, errors } };
    },
  );
}

/** Default (no injected validator): structural mini-schema only. Integration wires the real one. */
export const validateSchemaPrimitive: Registration = makeValidateSchema();
