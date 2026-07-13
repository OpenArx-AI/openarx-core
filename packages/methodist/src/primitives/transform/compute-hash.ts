// ── compute-hash v1 (transform · deterministic) ──────────────────────────────
//
// goal: content identifier — SHA-256 hex over canonical bytes (content_hash,
// bundle_id, manifest_hash). in: { bytes } · out: { hash } · access/effects: none.
// Same SHA-256-over-JCS-bytes scheme as the platform → same content_hash.

import { createHash } from 'node:crypto';
import { definePrimitive, type Registration } from '../../runtime/index.js';
import { asRecordArray } from '../shared.js';

/** SHA-256 hex over UTF-8 bytes. */
export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Assemble a record id: `<sourcePrefix>:<recordType>:<contentHash>` (platform §4.3). */
export function buildRecordId(sourcePrefix: string, recordType: string, contentHash: string): string {
  return `${sourcePrefix}:${recordType}:${contentHash}`;
}

interface In {
  /** single canonical-bytes string (unit tests) OR a records array with per-record
   *  canonical_bytes (checkpoint publish → content_hash per record). */
  bytes?: string;
  records?: unknown;
}
interface Out {
  hash?: string;
  records?: Array<Record<string, unknown>>;
}

export const computeHashPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'compute-hash',
    version: 'v1',
    kind: 'transform',
    goal: 'SHA-256 hex over canonical bytes (content_hash / bundle_id / manifest_hash)',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => {
    if (typeof inputs.bytes === 'string') return { outputs: { hash: sha256Hex(inputs.bytes) } };
    const out = asRecordArray(inputs.records).map((r) => ({
      ...r,
      content_hash: typeof r.canonical_bytes === 'string' ? sha256Hex(r.canonical_bytes) : null,
    }));
    return { outputs: { records: out } };
  },
);
