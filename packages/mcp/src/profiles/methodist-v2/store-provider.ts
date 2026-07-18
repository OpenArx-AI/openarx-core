// ── methodist-v2 door-engine StoreProvider (F2.3) ────────────────────────────
//
// Binds the interpreter runtime's store contract to the platform's real backends:
//   run-state / graph / activities → Neo4j (wave-v2 process + scientific graph)
//   dossier                        → Postgres (credential competence map)
//   journal                        → Postgres methodist_run_journal (047): door
//                                    exchange events (append) + the live tool-log
//                                    the crosscheck reconciles against (list by run)
//   hash-index                     → Postgres methodist_idempotency (047)
//   vector                         → Layer2VectorStore (Qdrant `layer2_claims`): GO-claims are
//                                    vectorized on WRITE via upsertClaimPoint — LIVE (bd openarx-ywje
//                                    CLOSED, prod-verified @0.84 by paraphrase). NB the READ side is
//                                    write-only here: Layer2VectorStore.searchClaims exists but no
//                                    agent-facing semantic read over layer2 is wired/exposed yet.

import { randomUUID } from 'node:crypto';
import {
  neoGet,
  neoGetAny,
  neoListActivitiesByType,
  neoPut,
  neoPutRelation,
  neoPutBundle,
  getDossier,
  upsertDossier,
  appendRunJournal,
  listRunJournal,
  listRunToolLog,
  getMethodistIdempotency,
  Layer2VectorStore,
  projectionTextHash,
  PAYLOAD_SCHEMA_VERSION,
  type ClaimPointPayload,
  type DossierPatch,
} from '@openarx/api';
import {
  graphMapping,
  type StoreProvider,
  type StoreName,
  type ReadHandle,
  type WriteHandle,
  type AppendOnlyHandle,
  type MutableHandle,
  type NodeSchema,
} from '@openarx/methodist';

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});

/** record_schemas registry (§12.7) — the graph writes read each type's `node` block from
 *  here to drive the Neo4j indexed scalars (schema-driven; replaces hardcoded attester_id). */
export function buildStores(
  recordSchemas: Record<string, { node?: NodeSchema }> = {},
): StoreProvider {
  // §12.6/2c: the methodist GO-claim vector sink. Constructed once; ensureCollection is
  // idempotent (creates layer2_claims + payload indexes if absent, no-op otherwise).
  const vectorStore = new Layer2VectorStore();
  void vectorStore
    .ensureCollection()
    .catch((e) =>
      console.error(
        '[methodist-v2] vector ensureCollection failed:',
        e instanceof Error ? e.message : e,
      ),
    );
  return {
    read(store: StoreName): ReadHandle {
      switch (store) {
        case 'run-state':
          return { store, get: (id) => neoGet('run', 'run_id', id), list: async () => [] };
        case 'dossier':
          return {
            store,
            get: async (c) => {
              const d = await getDossier(c);
              // Only the flat competence map enters the model (§8.7).
              return d
                ? {
                    autonomy_by_context: d.autonomy_by_context,
                    passed_units: d.passed_units,
                    tier_by_context: d.tier_by_context,
                    patches_received: d.patches_received,
                    corrections: d.corrections,
                  }
                : undefined;
            },
            list: async () => [],
          };
        case 'graph':
          // §12.7 schema-driven read: return the record WITH its type (Neo4j label) so
          // read-graph can key the per-type read schema off it (was hardcoded to 'claim',
          // which found only claims). record_type is a read-meta field, not stored data.
          return {
            store,
            get: async (id) => {
              const hit = await neoGetAny(id);
              return hit ? { record_type: hit.record_type, ...hit.record } : undefined;
            },
            list: async () => [],
          };
        case 'journal':
          return {
            store,
            get: async () => undefined,
            list: async (spec) => {
              const runId = asRec(spec).run_id;
              if (typeof runId !== 'string') return [];
              // Union the door exchange events (append-journal) with the LIVE tool-log
              // (MCP call-interception, migration 048) — crosscheck-tool-usage filters
              // entries carrying a `tool` field to reconcile claimed_usage (§8 inv-4).
              const [events, tools] = await Promise.all([
                listRunJournal(runId),
                listRunToolLog(runId),
              ]);
              return [...events, ...tools];
            },
          };
        case 'activities':
          // §12.1 finalization read (fetch-run-closeout): list activities by indexed
          // `activity_type` scalar (e.g. 'version_closeout'); the primitive filters the
          // small result by run_id + is_superseded. Keyed get is not used on this path.
          return {
            store,
            get: async () => undefined,
            list: async (spec) => {
              const activityType = asRec(spec).activity_type;
              if (typeof activityType !== 'string') return [];
              return neoListActivitiesByType(activityType);
            },
          };
        case 'hash-index':
          return {
            store,
            get: async (key) => (await getMethodistIdempotency(key)) ?? undefined,
            list: async () => [],
          };
        default:
          return { store, get: async () => undefined, list: async () => [] };
      }
    },
    write(store: StoreName): WriteHandle {
      switch (store) {
        case 'run-state':
          return {
            store,
            put: async (id, n) => {
              const r = asRec(n);
              // §12.1 (oyq): expose `cycle` as a queryable INTEGER scalar (the filter/sort key —
              // e.g. `MATCH (r:run) WHERE r.cycle = 9`) + `cycle_name` for display. The full value
              // stays in _data (update-run-state normalized it); only add the scalar when present.
              await neoPut('run', 'run_id', id, r, {
                credential_id: String(r.credential_id ?? ''),
                status: String(r.status ?? ''),
                ...(typeof r.cycle === 'number' ? { cycle: r.cycle } : {}),
                ...(typeof r.cycle_name === 'string' ? { cycle_name: r.cycle_name } : {}),
              });
            },
            patch: async () => {},
            delete: async () => {},
          } as MutableHandle;
        case 'dossier':
          return {
            store,
            put: async (c, m) => {
              await upsertDossier(c, m as DossierPatch);
            },
            patch: async () => {},
            delete: async () => {},
          } as MutableHandle;
        case 'graph':
          return {
            store,
            put: async (id, w) => {
              const r = asRec(w);
              const rec = asRec(r.record);
              const recordType = String(r.record_type ?? 'claim');
              // §12.7: schema-driven indexed scalars (node.indexed_properties) — was hardcoded {attester_id}.
              const mapping = graphMapping(recordType, rec, recordSchemas[recordType]?.node);
              // methodist write-path observability (Vlad): log every relation write + whether the
              // companion edge projection was built (both endpoints present). hasEdge=false means the
              // relation persists as a node but NO edge (missing/empty source_claim_id/target_claim_id)
              // — surfaces the exact spot a ward's relation silently fails to become an edge.
              if (recordType === 'relation') {
                console.error(
                  JSON.stringify({
                    at: 'graph.put.relation',
                    id: id.slice(0, 48),
                    hasEdge: !!mapping.edge,
                    rawSource: String(rec.source_claim_id ?? '(absent)').slice(0, 48),
                    rawTarget: String(rec.target_claim_id ?? '(absent)').slice(0, 48),
                    relation: String(rec.relation ?? '(absent)'),
                  }),
                );
              }
              // §12.8 Model C: a relation persists as the node-record (source of truth) AND its
              // companion TYPED traversal edge, atomically. The edge label = the relation type
              // (native rel-type traversal + multi-hop); it carries ONLY rel_id, hash-excluded —
              // identity stays on the node. Non-relation records, and a relation missing its
              // endpoints (no mapping.edge), take the plain node upsert.
              if (recordType === 'relation' && mapping.edge) {
                await neoPutRelation(id, mapping.data, mapping.scalars, {
                  source: mapping.edge.source,
                  target: mapping.edge.target,
                  label: mapping.edge.label,
                });
              } else if (recordType === 'bundle' && mapping.bundleEdges) {
                // §12.1 bundle-by-reference (openarx-1ed5): persist the bundle node + one
                // member-reference edge per EXISTING member claim (no re-mint). An RO-Crate or
                // member-less bundle has no mapping.bundleEdges → plain node upsert below.
                await neoPutBundle(id, mapping.data, mapping.scalars, {
                  members: mapping.bundleEdges.members,
                  label: mapping.bundleEdges.label,
                });
              } else {
                await neoPut(mapping.label, 'id', id, mapping.data, mapping.scalars);
              }
            },
            patch: async () => {},
            delete: async () => {},
          } as MutableHandle;
        case 'activities':
          return {
            store,
            append: async (e) => {
              const id = `act:${randomUUID()}`;
              const r = asRec(e);
              const mapping = graphMapping('activity', r, recordSchemas['activity']?.node);
              await neoPut('activity', 'id', id, r, mapping.scalars);
              return { id };
            },
          } as AppendOnlyHandle;
        case 'journal':
          return {
            store,
            append: async (e) => {
              const r = asRec(e);
              return appendRunJournal({
                run_id: String(r.run_id ?? ''),
                event: r.event == null ? null : String(r.event),
                payload: r.payload,
              });
            },
          } as AppendOnlyHandle;
        case 'vector':
          // §12.6/2c: methodist GO-claim projections → Qdrant `layer2_claims`. The primitive
          // has already rendered the schema projection + embedded it (gemini); here we complete
          // the ClaimPointPayload (computed claim_id/text_hash/embedded_at/schema_version) and
          // upsert with the gemini named vector only (specter2 = later schema-driven swap).
          return {
            store,
            put: async (id, v) => {
              const r = asRec(v);
              const ref = typeof r.ref === 'string' ? r.ref : null;
              const vector = r.vector;
              if (!ref || !Array.isArray(vector)) {
                console.error(`[methodist-v2] vector put skipped (no ref/vector): ${id}`);
                return;
              }
              const pf = asRec(r.payload);
              const text = typeof r.text === 'string' ? r.text : '';
              const payload: ClaimPointPayload = {
                claim_id: ref,
                payload_schema_version: PAYLOAD_SCHEMA_VERSION,
                text_hash: projectionTextHash(text),
                embedded_at: new Date().toISOString(),
                modality: (pf.modality ?? null) as string | null,
                claim_type: (pf.claim_type ?? null) as string | null,
                claim_status: (pf.claim_status ?? null) as string | null,
                verification_outcome: (pf.verification_outcome ?? null) as string | null,
                attester_id: String(pf.attester_id ?? ''),
                run_id: (pf.run_id ?? null) as string | null,
                is_superseded: Boolean(pf.is_superseded ?? false),
                attested_at:
                  typeof pf.attested_at === 'string' ? pf.attested_at : new Date().toISOString(),
                is_engineering_connected: Boolean(r.is_engineering_connected ?? false), // §12.9 P3
              };
              // §12.9 P3: the primitive also embedded an engineering-edge projection (gemini_eng);
              // upsert both named vectors (gemini §7 + gemini_eng) so eng-search can query the eng space.
              const vectorEng = Array.isArray(r.vector_eng)
                ? (r.vector_eng as number[])
                : undefined;
              await vectorStore.upsertClaimPoint(
                ref,
                { gemini: vector as number[], gemini_eng: vectorEng },
                payload,
              );
            },
            patch: async () => {},
            delete: async (id) => {
              const claimId = id.startsWith('vec:') ? id.slice(4) : id;
              await vectorStore.deleteClaimPoint(claimId).catch(() => undefined);
            },
          } as MutableHandle;
        default:
          return {
            store,
            put: async () => {},
            patch: async () => {},
            delete: async () => {},
            append: async () => ({ id: `x:${randomUUID()}` }),
          } as AppendOnlyHandle & MutableHandle;
      }
    },
  };
}
