// ── Layer 2 — canonical serialization + content_hash (§4.3) ──────────────────
//
// CATASTROPHIC-BREAKING surface (§9.2): changing anything here shifts every
// record id. Scheme is PURE RFC 8785 (JSON Canonicalization Scheme, JCS) via the
// stock `canonicalize` reference library — NO Unicode/NFC pre-step (contract
// §4.3 rev6, Vlad sign-off, commit 957bc39). Independent client implementations
// (Python/Go/Rust RFC 8785 libs) MUST reproduce the same canonical bytes and thus
// the same content_hash. Golden vectors in layer2-hash.test.ts lock this.

import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  buildRecordId,
  HASH_INCLUDED_FIELDS,
  type Claim,
  type Layer2Record,
  type RecordType,
} from './layer2.js';

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Canonicalize an already-scoped object to RFC 8785 bytes. */
export function canonicalBytes(obj: unknown): string {
  const out = canonicalize(obj);
  // `canonicalize` returns undefined only for a top-level `undefined` input,
  // which never happens for a record scope object.
  if (out === undefined) throw new Error('canonicalize produced no output (undefined input)');
  return out;
}

/**
 * Build the hash-scope object for a record: the HASH_INCLUDED_FIELDS for its
 * type, including only fields that are present (defined). Absent fields are
 * omitted, never serialized as null (§4.3). Relation's `shared_source_uri` /
 * `interpretation_difference` enter the hash ONLY for `shared_evidence`
 * relations; `mediator` enters whenever present.
 */
export function extractHashScope(record: Layer2Record): Record<string, unknown> {
  const type = record.record_type as RecordType;
  const rec = record as unknown as Record<string, unknown>;
  const scope: Record<string, unknown> = {};
  for (const field of HASH_INCLUDED_FIELDS[type]) {
    if (
      type === 'relation' &&
      (field === 'shared_source_uri' || field === 'interpretation_difference') &&
      rec['relation'] !== 'shared_evidence'
    ) {
      continue; // shared_evidence-only fields
    }
    if (
      type === 'relation' &&
      rec['relation'] === 'same_as' &&
      (field === 'direction' || field === 'mediator')
    ) {
      continue; // §7.6 P1: same_as is symmetric — direction/mediator are not part of its identity.
      // Combined with endpoint-order canonicalization at insert (source<target),
      // same_as(A,B) and same_as(B,A) yield the SAME content_hash → one row, mirror-deduped.
    }
    let value = rec[field];
    // §4.3 bundle identity (openarx-1ed5): `members` is a SET of referenced claim_ids —
    // sort its elements for order-independent identity (JCS preserves array order, so the
    // sort must happen here, before canonicalization). Mirrors same_as endpoint-ordering.
    if (type === 'bundle' && field === 'members' && Array.isArray(value)) {
      value = [...(value as unknown[])].sort();
    }
    if (value !== undefined) scope[field] = value;
  }
  return scope;
}

/** Canonical bytes of a record's hash-scope — persist these for §8.4 idempotency. */
export function recordCanonicalBytes(record: Layer2Record): string {
  return canonicalBytes(extractHashScope(record));
}

/** content_hash — SHA-256 hex over the JCS-canonical hash-scope (§4.3). */
export function computeContentHash(record: Layer2Record): string {
  return sha256Hex(recordCanonicalBytes(record));
}

/**
 * source_digest — SHA-256 hex over JCS-canonical {content, evidence} of a claim.
 * Tamper-evidence hash, DISTINCT from the (broader) content_hash used for the id.
 */
export function computeSourceDigest(claim: Pick<Claim, 'content' | 'evidence'>): string {
  return sha256Hex(canonicalBytes({ content: claim.content, evidence: claim.evidence }));
}

export interface AssignedId {
  id: string;
  contentHash: string;
  canonicalBytes: string;
}

/**
 * Compute the id for a record under a source prefix. Returns the id plus the
 * content_hash and canonical bytes (the latter to be persisted for byte-exact
 * idempotency vs id_collision detection, §8.4).
 */
export function assignRecordId(record: Layer2Record, sourcePrefix: string): AssignedId {
  const bytes = recordCanonicalBytes(record);
  const contentHash = sha256Hex(bytes);
  return {
    id: buildRecordId(sourcePrefix, record.record_type as RecordType, contentHash),
    contentHash,
    canonicalBytes: bytes,
  };
}
