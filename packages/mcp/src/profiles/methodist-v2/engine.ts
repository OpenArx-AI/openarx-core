// ── methodist-v2 door engine (F2.3) ──────────────────────────────────────────
//
// Assembles the interpreter's InterpreterDeps once: the primitive Registry (with
// real capability injections), the Vertex model client, the real StoreProvider,
// and the methodist's methodology-JSON + door prompts + frame specs. Door handlers
// call runEndpoint(engine, <endpoint>, input) against this.

import { randomUUID } from 'node:crypto';
import { VertexLlm, EmbedClient, recordMethodistLlmCost, validateRecordShape } from '@openarx/api';
import { assignRecordId, RECORD_TYPES, type Layer2Record } from '@openarx/types';
import {
  Registry,
  allPrimitives,
  type InterpreterDeps,
  type ModelClient,
  type Methodology,
  type FrameSpecs,
  type Embed,
} from '@openarx/methodist';
import { buildStores } from './store-provider.js';
import { methodology as methodologyBase, doorPrompts, recordSchemas } from './assets/content.js';

// 7p80 (contracts identity-ruling, ticket 0093 / pillar §12.1): the canonical RECORD
// family (claim/relation/activity/metric/bundle) derives ONE identity via the pillar's
// §4.3 `assignRecordId` (RFC 8785 JCS content-hash + per-record-type hash-scope) — the
// SAME entry point layer2-store uses on every insert, so methodist records + all future
// records converge/dedup on one identity scheme. PROCESS nodes (run/intent/decision/…)
// are mutable operational state → OPAQUE generated ids, never content-addressed (a
// content-hash would shift on every mutation).
const RECORD_TYPE_SET = new Set<string>(RECORD_TYPES);
const assignId = (record: Record<string, unknown>, recordType: string, prefix: string): string =>
  RECORD_TYPE_SET.has(recordType)
    ? assignRecordId({ ...record, record_type: recordType } as unknown as Layer2Record, prefix).id
    : `${prefix}:${recordType}:${randomUUID()}`;

// Frame-held hash scopes (per record type) + base schema, referenced by the
// methodology via `hash_scope: "frame_default"` / `schema_ref: "layer2_v12"`.
const CLAIM_SCOPE = { include: ['content', 'evidence', 'attester_id', 'attested_at', 'cycle_context', 'authority_chain'] };
const REL_SCOPE = { include: ['source_claim_id', 'target_claim_id', 'relation', 'attester_id', 'attested_at'] };
const ACT_SCOPE = {
  include: ['activity_type', 'attested_at', 'wasAssociatedWith', 'generated', 'activity_content', 'applied_instrument', 'genre', 'attester_id'],
};
const FRAME_SPECS: FrameSpecs = {
  hashScopes: { frame_default: { claim: CLAIM_SCOPE, relation: REL_SCOPE, activity: ACT_SCOPE, metric: CLAIM_SCOPE, bundle: CLAIM_SCOPE } },
  schemas: { layer2_v12: { type: 'object' } },
  // Phase 0.2 / §12.7 record_schemas registry (methodist-owned VALUES from source/record_schemas.json;
  // empty until Phase 1/Wave-2). The graph/vector/read adapters (2b) consume it via `params.record_schema`.
  recordSchemas: recordSchemas as unknown as Record<string, unknown>,
};

// 2c/§12.6: the real embedder for vectorize-and-store (methodist GO-claim projections
// → Qdrant). CURRENT embedding = gemini (gemini-embedding-2-preview) via the embed-service,
// the same path the live layer2-embed worker uses — NOT gated on specter2/ywje (Vlad/PM
// directive: specter2 is a later schema-driven swap). One text → its gemini vector.
const embedClient = new EmbedClient({
  url: process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
  secret: process.env.CORE_INTERNAL_SECRET ?? '',
});
const geminiEmbed: Embed = async (text: string) => {
  const r = await embedClient.callEmbed([text], 'gemini-embedding-2-preview');
  return r.vectors[0] ?? [];
};

let cached: InterpreterDeps | null = null;

/** Build (once) the interpreter deps the door handlers run procedures against. */
export function buildDoorEngine(): InterpreterDeps {
  if (cached) return cached;

  const vertex = new VertexLlm({ apiKey: process.env.GOOGLE_AI_API_KEY });
  const model: ModelClient = {
    async generate(req) {
      const r = await vertex.complete('enrichment', req.context, {
        model: req.modelId || process.env.METHODIST_MODEL,
        responseMimeType: 'application/json',
        responseSchema: req.outputSchema,
        // openarx-tester-8lf: 1024 intermittently TRUNCATED the diagnose dose (operations +
        // beacons + expected_artifacts + counters + probe) for rich/complex research intents →
        // cut JSON → bad-output → 'rejected'. 8192 gives ample headroom (a normal dose is
        // ~400 tokens; the model only spends more when the intent genuinely needs it).
        maxTokens: 8192,
      });
      // 2h context-cache ROI (gs21): the big fixed methodology/TRIZ prefix (prepare-context's
      // staticPrefix, identified by cache_anchor) is repeated on every door call, so on Gemini
      // 3.x implicit caching (≥4096-token prefix) it should be served from cache at ~90% off.
      // Log the per-call hit-rate so the cache payoff is observable in stats — a rising
      // cachedTokens/inputTokens ratio proves the prefix is caching; a flat 0 means the prefix
      // never hits (below threshold, or drifting per-call → not byte-identical). §logging std.
      const cachedTokens = r.cachedTokens ?? 0;
      const cacheHitPct = r.inputTokens > 0 ? Math.round((cachedTokens / r.inputTokens) * 100) : 0;
      console.error(
        JSON.stringify({
          at: 'methodist.model-call',
          model: r.model,
          inputTokens: r.inputTokens,
          cachedTokens,
          cacheHitPct,
          outputTokens: r.outputTokens,
          cost: r.cost,
          cacheAnchor: req.cacheAnchor ? req.cacheAnchor.slice(0, 12) : null,
        }),
      );
      // 694n: persist the cost row (Console shows daily cost + cache-hit rate + per-version slice).
      // Best-effort — a cost-log failure must never break the door call. methodology_version comes
      // from the loaded config (closure); door/run_id/credential slicing is a follow-up (needs
      // threading through the call-model path — the model-client is door-agnostic today).
      void recordMethodistLlmCost({
        model: r.model,
        inputTokens: r.inputTokens,
        cachedTokens,
        outputTokens: r.outputTokens,
        cost: r.cost,
        methodologyVersion: (methodologyBase as { methodology_version?: string }).methodology_version ?? null,
      }).catch((e) => console.error('[methodist llm-cost]', e instanceof Error ? e.message : e));
      return { raw: r.text };
    },
  };

  const registry = new Registry();
  registry.registerAll(
    allPrimitives({
      assignId,
      langId: () => ({ lang: 'en', confidence: 0.9 }),
      embed: geminiEmbed,
      mintId: (credential: string) => `run:${credential}:${randomUUID()}`,
      now: () => new Date().toISOString(),
      // §12.7: read-graph keys its per-type read projection off the record_schemas registry.
      recordSchemas: recordSchemas as unknown as Record<string, unknown>,
      // openarx-xpfz: fail-closed record well-formedness — validate-schema rejects a malformed
      // (e.g. flat, non-content-wrapped) claim before the id/write path (frame-integrity, §1-bis).
      validateShape: (record: unknown, recordType: string) =>
        validateRecordShape(record, recordType).map((i) => i.message),
    }),
  );

  // Merge the methodist's prompt bodies + Vertex output-schemas into the methodology.
  const methodology = {
    ...methodologyBase,
    prompts: doorPrompts.prompts,
    schemas: doorPrompts.schemas,
  } as unknown as Methodology;

  cached = {
    runtime: {
      registry,
      // §12.7: graph writes read node.indexed_properties from the record_schemas registry.
      stores: buildStores(recordSchemas as unknown as Record<string, { node?: { indexed_properties?: string[] } }>),
      model,
      // the diagnose prompt (full dossier + intent) can exceed the 30s default.
      modelPolicy: { attempts: 2, timeoutMs: 90_000 },
    },
    methodology,
    frameSpecs: FRAME_SPECS,
  };
  return cached;
}
