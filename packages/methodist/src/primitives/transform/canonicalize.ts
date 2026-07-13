// ── canonicalize v1 (transform · deterministic) ──────────────────────────────
//
// goal: canonicalize record hash-scopes to RFC 8785 (JCS) bytes.
// Dual form: a single { record } + params.hash_scope (a single HashScope — the
// byte-identity path, unit-tested against the platform golden vectors), OR a
// { records } array + params.hash_scope as a PER-record-type map (the checkpoint
// publish path — each record's scope is picked by record_type). Uses the same
// external `canonicalize` (no NFC) the platform uses. hash_scope is resolved by
// the interpreter from a frame ref (e.g. 'frame_default'); §12 hard-invariant, the
// methodology never tunes it.

import { createRequire } from 'node:module';
import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';
import { extractScope, type HashScope } from './hash-scope.js';
import { asRecordArray, type RecordEntry } from '../shared.js';

const require = createRequire(import.meta.url);
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined;

interface In {
  record?: Record<string, unknown>;
  records?: unknown;
}
interface Params {
  hash_scope: HashScope | Record<string, HashScope>;
}
interface Out {
  canonical_bytes?: string;
  records?: Array<RecordEntry & { canonical_bytes: string }>;
}

function jcs(scope: unknown): string {
  const bytes = canonicalize(scope);
  if (bytes === undefined) throw new RuntimeError('bad-output', 'canonicalize produced no output');
  return bytes;
}

export const canonicalizePrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'canonicalize',
    version: 'v1',
    kind: 'transform',
    goal: 'canonicalize record hash-scopes to RFC 8785 JCS bytes',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ params, inputs }) => {
    const isSingleScope = (hs: Params['hash_scope']): hs is HashScope => 'include' in hs;

    if (inputs.record !== undefined) {
      const hs = isSingleScope(params.hash_scope) ? params.hash_scope : (params.hash_scope[inputs.record.record_type as string] ?? { include: [] });
      return { outputs: { canonical_bytes: jcs(extractScope(inputs.record, hs)) } };
    }

    const scopeFor = (recordType: string): HashScope =>
      isSingleScope(params.hash_scope) ? params.hash_scope : (params.hash_scope[recordType] ?? { include: [] });
    const out = asRecordArray(inputs.records).map((r) => ({
      ...r,
      canonical_bytes: jcs(extractScope((r.record ?? {}) as Record<string, unknown>, scopeFor(r.record_type))),
    }));
    return { outputs: { records: out } };
  },
);
