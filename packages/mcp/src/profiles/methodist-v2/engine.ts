// ── methodist-v2 door engine (F2.3) ──────────────────────────────────────────
//
// Assembles the interpreter's InterpreterDeps once: the primitive Registry (with
// real capability injections), the Vertex model client, the real StoreProvider,
// and the methodist's methodology-JSON + door prompts + frame specs. Door handlers
// call runEndpoint(engine, <endpoint>, input) against this.

import { randomUUID } from 'node:crypto';
import { VertexLlm, OpenRouterLlm, EmbedClient, recordMethodistLlmCost, validateRecordShape, makeLlmLangId, DEFAULT_LANG_DETECT_MODEL } from '@openarx/api';
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
// §4.3 bundle identity (openarx-1ed5): bundle_type discriminates kind; members = the referenced
// claim_id SET (sortFields → order-independent identity); manifest present-only (RO-Crate only).
// synthesis_narrative is EXCLUDED (projection, mutable-in-place). This REPLACES the prior
// CLAIM_SCOPE placeholder, which degenerated to {attester_id, attested_at} for a bundle
// (no content/evidence) → every synthesis bundle by one attester at one ts would collide.
const BUNDLE_SCOPE = {
  include: ['bundle_type', 'members', 'manifest', 'attester_id', 'attested_at'],
  sortFields: ['members'],
};
const FRAME_SPECS: FrameSpecs = {
  hashScopes: { frame_default: { claim: CLAIM_SCOPE, relation: REL_SCOPE, activity: ACT_SCOPE, metric: CLAIM_SCOPE, bundle: BUNDLE_SCOPE } },
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
// Scope-B B1.2 (lsqk.17): the alt-model embedder for the 768 "specter2" slot — qwen3-embedding-8b
// over the SAME §7 scientific projection as gemini (the two-model availability-insurance alt-vector;
// the 3250 existing claims were backfilled by layer2-qwen-backfill.ts). allowFallback = the reference
// recipe (pool → OpenRouter if the GPU pool is down). Wired unconditionally but INERT until
// LAYER2_ALT_VECTOR=true gates the write inside vectorize-and-store (the specter2 slot already exists,
// so no schema-op is needed — unlike gemini_eng's collection recreate).
const qwenEmbed: Embed = async (text: string) => {
  const r = await embedClient.callEmbed([text], 'qwen3-embedding-8b', { allowFallback: true });
  return r.vectors[0] ?? [];
};

let cached: InterpreterDeps | null = null;

/** Build (once) the interpreter deps the door handlers run procedures against. */
export function buildDoorEngine(): InterpreterDeps {
  if (cached) return cached;

  // Provider selection mirrors DefaultModelRouter: Vertex while Google credentials are configured,
  // OpenRouter otherwise. It used to be a hardcoded VertexLlm, which meant the methodist doors were
  // the ONE path that could not follow a provider switch — removing the Google credentials would have
  // left every door calling an unconfigured Vertex. Both classes expose the same complete() shape, and
  // OpenRouterLlm rewrites bare `gemini-*` ids to their `google/…` spelling, so the door prompts and
  // METHODIST_MODEL keep working unchanged under either provider.
  const googleCreds = process.env.GOOGLE_SA_KEY_FILE ?? process.env.GOOGLE_AI_API_KEY;
  const llm: { complete: VertexLlm['complete'] } = googleCreds
    ? new VertexLlm({
        apiKey: process.env.GOOGLE_AI_API_KEY,
        serviceAccountKeyFile: process.env.GOOGLE_SA_KEY_FILE,
      })
    : new OpenRouterLlm({ apiKey: process.env.OPENROUTER_API_KEY ?? '' });
  console.error(`[methodist-v2] LLM provider: ${googleCreds ? 'vertex' : 'openrouter'}`);
  const model: ModelClient = {
    async generate(req) {
      const r = await llm.complete('enrichment', req.context, {
        model: req.modelId || process.env.METHODIST_MODEL,
        responseMimeType: 'application/json',
        responseSchema: req.outputSchema,
        // openarx-tester-8lf: 1024 intermittently TRUNCATED the diagnose dose (operations +
        // beacons + expected_artifacts + counters + probe) for rich/complex research intents →
        // cut JSON → bad-output → 'rejected'. A normal dose is ~400 tokens; the model only spends
        // more when the intent genuinely needs it.
        //   • sbt2 / batch-3 D4: 8192 in turn TRUNCATED a LARGE version_closeout grading OUTPUT
        //     (checkpoint_verdict: per-record verdicts + corrections + reasons + AAR-metrics for a
        //     big closeout) → the same cut-JSON→bad-output→rejected. This is a CAP (a shared limit
        //     across all model-calls: diagnose/verdict/verify/ask); raising it leaves small calls
        //     unaffected and only gives the large-closeout grading the headroom it needs. Orthogonal
        //     to v1.25 redact-fields (that trims the verdict INPUT prose; this is the OUTPUT budget).
        maxTokens: 32768,
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

  // english-only ingress (MASTER §3.4): the real detector for the checkpoint's detect-language step.
  // flash-lite (Vlad: cheapest flash, NOT pro; detects the actual LANGUAGE so ANY non-English is
  // caught, incl. Latin-script es/fr/de). LLM-agnostic detector over the injected vertex completion;
  // the detect-language step's gate (methodist procedure) rejects a confident non-en fail-closed.
  const langDetect = makeLlmLangId(
    async (prompt, opts) =>
      (
        await llm.complete('enrichment', prompt, {
          model: opts.model,
          responseMimeType: opts.responseMimeType,
          responseSchema: opts.responseSchema,
          maxTokens: opts.maxTokens,
        })
      ).text,
    process.env.LANG_DETECT_MODEL ?? DEFAULT_LANG_DETECT_MODEL,
  );

  const registry = new Registry();
  registry.registerAll(
    allPrimitives({
      assignId,
      langId: langDetect,
      embed: geminiEmbed,
      embedAlt: qwenEmbed, // Scope-B B1.2: qwen → 768 "specter2" slot (gated by LAYER2_ALT_VECTOR)
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
