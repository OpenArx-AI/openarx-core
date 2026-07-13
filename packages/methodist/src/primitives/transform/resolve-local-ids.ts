// ── resolve-local-ids v1 (transform · deterministic) ─────────────────────────
//
// goal: resolve bundle-local `_:` ids to canonical content-derived ids (two-pass,
// dependency-driven), so `_:` never persists and ids stay content-derived.
// in: { constituents, manifest }, params: { sourcePrefix } · out: { bundle_resolved, id_map }.
//
// Ported from the platform's resolveBundleLocalIds (F-1). The id ALLOCATOR is
// INJECTED (framework "access: id allocation") — a deterministic capability the
// runtime supplies: in tests a content-hash stub, at integration the platform's
// assignRecordId (canonicalize → compute-hash → buildRecordId). The resolution
// LOGIC (topo order over hash-included refs, cycle/dangling/duplicate detection,
// deep manifest walk) is what this primitive owns and what its tests exercise.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

const LOCAL = '_:';
const isLocal = (v: unknown): v is string => typeof v === 'string' && v.startsWith(LOCAL);

/** Deterministic id allocator: (resolved record, type, sourcePrefix) → canonical id. */
export type AssignId = (
  record: Record<string, unknown>,
  recordType: string,
  sourcePrefix: string,
) => string;

/** Hash-INCLUDED plain-string reference fields per record type (id-affecting). */
const HASH_REF_FIELDS: Record<string, string[]> = {
  claim: [],
  relation: ['source_claim_id', 'target_claim_id'],
  activity: ['used', 'generated', 'wasInformedBy', 'wasAssociatedWith'],
  metric: ['wasGeneratedBy', 'measures_entity'],
};

/** Hash-EXCLUDED reference fields — substituted post-map; never gate ordering. */
const EXCLUDED_REF_FIELDS = ['supersedes'];

export interface Constituent {
  record_type: string;
  record: Record<string, unknown>;
  local_id?: string | null;
}

interface Entry {
  index: number;
  localId: string | null;
  type: string;
  record: Record<string, unknown>;
}

function badRef(ref: string, where: string): never {
  throw new RuntimeError('bad-output', `unresolved_local_ref: '${ref}' referenced by ${where}`);
}

function collectLocalRefs(record: Record<string, unknown>, type: string): string[] {
  const refs: string[] = [];
  for (const field of HASH_REF_FIELDS[type] ?? []) {
    const v = record[field];
    if (isLocal(v)) refs.push(v);
    else if (Array.isArray(v)) for (const item of v) if (isLocal(item)) refs.push(item);
  }
  return refs;
}

function substituteRefs(
  record: Record<string, unknown>,
  type: string,
  map: Map<string, string>,
  where: string,
  fields: readonly string[] = HASH_REF_FIELDS[type] ?? [],
): Record<string, unknown> {
  const out = { ...record };
  for (const field of fields) {
    const v = out[field];
    if (isLocal(v)) {
      out[field] = map.get(v) ?? badRef(v, `${where}.${field}`);
    } else if (Array.isArray(v)) {
      out[field] = v.map((item) => (isLocal(item) ? (map.get(item) ?? badRef(item, `${where}.${field}[]`)) : item));
    }
  }
  return out;
}

interface In {
  submission: { records?: SubmissionRecord[] };
  /** verdict is present in the checkpoint procedure but UNUSED here — the
   *  verdict-branch lives in write-graph-records (§4). */
  verdict?: unknown;
  /** §1-bis: the credential (= §4.3 id prefix AND attester) — FRAME-injected by the interpreter
   *  from the runtime endpoint input, NOT a methodology binding. Preferred over params.sourcePrefix
   *  (the static param path stays for tests). */
  sourcePrefix?: string;
}
/** A submission record: bundle-local id + type via `kind`, plus §12 fields. */
interface SubmissionRecord {
  local_id?: string | null;
  kind?: string;
  record_type?: string;
  [field: string]: unknown;
}
interface Params {
  /** attester/source prefix for content-derived ids (the mentee credential) */
  sourcePrefix: string;
}
interface Out {
  records_resolved: Array<{ record_type: string; record: Record<string, unknown> }>;
  id_map: Record<string, string>;
}

export function makeResolveLocalIds(assignId: AssignId): Registration {
  return definePrimitive<Params, In, Out>(
    {
      id: 'resolve-local-ids',
      version: 'v1',
      kind: 'transform',
      goal: 'resolve bundle-local _: ids to canonical content-derived ids (two-pass)',
      access: [],
      effects: [],
      determinism: 'deterministic',
    },
    ({ params, inputs }) => {
      // §1-bis: prefer the FRAME-injected runtime credential; fall back to the static param (tests).
      const sourcePrefix = inputs.sourcePrefix ?? params.sourcePrefix;
      const records = inputs.submission?.records ?? [];
      // Non-write-path (no records) → empty resolution; the publish sub-sequence
      // downstream no-ops (nothing to canonicalize/write).
      if (records.length === 0) return { outputs: { records_resolved: [], id_map: {} } };

      // Index local names; enforce shape + uniqueness within the bundle.
      const byLocal = new Map<string, Entry>();
      const entries: Entry[] = records.map((r, index) => {
        const localId = r.local_id ?? null;
        if (localId !== null) {
          if (!localId.startsWith(LOCAL)) badRef(localId, `records[${index}].local_id (must start with '_:')`);
          if (byLocal.has(localId)) badRef(localId, `records[${index}].local_id (duplicate within bundle)`);
        }
        const { local_id: _lid, kind, record_type, ...fields } = r;
        void _lid;
        const entry: Entry = { index, localId, type: kind ?? record_type ?? 'claim', record: fields };
        if (localId) byLocal.set(localId, entry);
        return entry;
      });

      // Pass 1 — topological resolution over hash-included local refs.
      const map = new Map<string, string>();
      const resolved = new Map<number, Record<string, unknown>>();
      const visiting = new Set<number>();

      const resolveEntry = (entry: Entry): void => {
        if (resolved.has(entry.index)) return;
        if (visiting.has(entry.index)) {
          badRef(
            entry.localId ?? `records[${entry.index}]`,
            `records[${entry.index}] (hash-level reference cycle — content-derived ids cannot be circular)`,
          );
        }
        visiting.add(entry.index);
        for (const ref of collectLocalRefs(entry.record, entry.type)) {
          const dep = byLocal.get(ref) ?? badRef(ref, `records[${entry.index}] (${entry.type})`);
          resolveEntry(dep);
        }
        const substituted = substituteRefs(entry.record, entry.type, map, `records[${entry.index}] (${entry.type})`);
        // §12.8 ruling (A) — SINGLE frame-guaranteed id-assignment: assign the FINAL §4.3 id HERE,
        // for EVERY record, so write-graph-records REUSES it (it reassigns only when record.id is
        // unset) — one assignment point, and relation refs resolve against the exact ids the claims
        // get. The id is computed on the record enriched with the identity-affecting attester_id
        // (= credential = sourcePrefix) — the §4.3 hash-scope (CLAIM_SCOPE/REL_SCOPE) INCLUDES
        // attester_id, which write-graph-records also sets to the credential; matching it here makes
        // the two computations byte-identical (val3 fix). The output record keeps attester_id UNSET
        // (write-graph-records adds it to the persisted record); only `id` is stamped here.
        substituted.id = assignId({ ...substituted, attester_id: sourcePrefix }, entry.type, sourcePrefix);
        resolved.set(entry.index, substituted);
        if (entry.localId) map.set(entry.localId, substituted.id as string);
        visiting.delete(entry.index);
      };
      for (const entry of entries) resolveEntry(entry);

      // ── §12.8 fail-closed identity guard (contracts ruling, openarx-xpfz) ───────
      // A record whose §4.3 id-affecting hash-scope is EMPTY hashes to the SAME id for
      // every such record under a credential — the id degenerates to a pure function of
      // the attester prefix. Persisting these silently MERGE-collapses N records into one
      // node and cross-run-overwrites others (claim-integrity loss: the flat-claim bug).
      // Fail closed instead of losing data:
      //   • degenerate — a record whose id equals the attester-only reference id for its
      //     type (contributed no id-affecting content; e.g. a claim with no content:{}).
      //   • collision  — two DIVERGENT records resolving to one id (would merge/lose).
      // Byte-identical records sharing an id are legitimate content-address dedup (kept).
      const degenerateRef = new Map<string, string>();
      const refFor = (type: string): string => {
        let ref = degenerateRef.get(type);
        if (ref === undefined) {
          ref = assignId({ attester_id: sourcePrefix }, type, sourcePrefix);
          degenerateRef.set(type, ref);
        }
        return ref;
      };
      const byId = new Map<string, number[]>();
      for (const entry of entries) {
        const id = resolved.get(entry.index)!.id as string;
        if (id === refFor(entry.type)) {
          throw new RuntimeError(
            'bad-output',
            `degenerate_record_identity: records[${entry.index}] (${entry.type}) contributed no id-affecting content — its id derives only from the attester and would collapse/overwrite other records. A claim must content-wrap its payload (content:{ text, ... }); flat records are malformed.`,
          );
        }
        const list = byId.get(id);
        if (list) list.push(entry.index);
        else byId.set(id, [entry.index]);
      }
      for (const [id, idxs] of byId) {
        if (idxs.length < 2) continue;
        const first = JSON.stringify(resolved.get(idxs[0]!));
        if (idxs.some((i) => JSON.stringify(resolved.get(i)) !== first)) {
          throw new RuntimeError(
            'bad-output',
            `id_collision: ${idxs.length} divergent records [${idxs.join(', ')}] resolve to one id ${id} and would MERGE into a single node, losing ${idxs.length - 1}. Their hash-scope is empty/degenerate — content-wrap the payloads.`,
          );
        }
      }

      // Pass 2 — hash-excluded refs (never gate ordering).
      const records_resolved = entries.map((entry) => ({
        record_type: entry.type,
        record: substituteRefs(
          resolved.get(entry.index)!,
          entry.type,
          map,
          `records[${entry.index}] (${entry.type})`,
          EXCLUDED_REF_FIELDS,
        ),
      }));

      return { outputs: { records_resolved, id_map: Object.fromEntries(map) } };
    },
  );
}
