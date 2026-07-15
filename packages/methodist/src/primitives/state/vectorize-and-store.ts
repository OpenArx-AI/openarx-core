// ── vectorize-and-store v1 (state · model[embedding] · §12.7 schema-driven) ──
//
// goal: embed + upsert vectors for the committed records that carry a `vector`
// schema block (today: claims). SCHEMA-DRIVEN (§12.7 externalize-point 2): the
// record_schema's `vector` block decides WHAT is vectorized, the projection
// template (fields → vector-text), the payload fields, and the models. The
// projection is rendered by buildEmbed — {{text}}/{{caveats}} from the record,
// {{run}}/{{edges}} COMPUTED from the run-context + the committed 1-hop relations
// (renderRunContext/renderEdges, mirroring @openarx/api buildClaimProjection, kept
// pure so @openarx/methodist needs no api dep). The projection text is embedded via
// the INJECTED embedder (real path: gemini) and handed — with its schema payload —
// to the injected `vector` store (mcp store-provider → Qdrant upsertClaimPoint).
//
// No-op when the write-set carries no vectorizable record (RETURN → no claim
// published → nothing to embed; I3). in: { committed } · out: { vector_ids }.
// access: none · effects: vector.

import { definePrimitive, type Registration } from '../../runtime/index.js';
import type { Embed } from '../retrieval/search-semantic.js';
import {
  buildEmbed,
  renderRunContext,
  renderEdges,
  type VectorSchema,
  type EnrichEdge,
} from '../../adapters/embed.js';

interface ResolvedRecord {
  record_type: string;
  record: Record<string, unknown>;
}
interface In {
  /** commit-bundle-atomic outputs { committed: [...], bundle_id }, threaded as the
   *  bare slot ref $committed. Bare array also accepted. */
  committed: unknown;
}
interface Out {
  vector_ids: string[];
}

/** The per-type record_schemas subset this primitive reads (only the `vector` block). */
type SchemaMap = Record<string, { vector?: VectorSchema } | undefined>;

/** Unwrap the committed set whether it arrives bare or as { committed: [...] }. */
function committedRecords(input: unknown): ResolvedRecord[] {
  if (Array.isArray(input)) return input as ResolvedRecord[];
  if (
    input &&
    typeof input === 'object' &&
    Array.isArray((input as { committed?: unknown }).committed)
  ) {
    return (input as { committed: ResolvedRecord[] }).committed;
  }
  return [];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 1-hop edges for a claim, from the committed relations; neighbour text from the
 *  committed claims. Deterministic order = write-set order. Best-effort: an edge whose
 *  neighbour text isn't in this write-set is skipped (enrichment, not correctness). */
function edgesFor(
  claimId: string,
  records: ResolvedRecord[],
  textById: Map<string, string>,
  forClass: 'epistemic' | 'engineering' = 'epistemic',
): EnrichEdge[] {
  const edges: EnrichEdge[] = [];
  for (const w of records) {
    if (w.record_type !== 'relation') continue;
    const r = w.record;
    // §12.8 (c) vector-segmentation + §12.9 P3: each class enriches its OWN claim vector — epistemic
    // (§7) edges the `gemini` (scientific) vector, engineering (ENG_*) edges the `gemini_eng` vector.
    // A §7 semantic search is never confounded by engineering-path edges, and vice versa (label-space
    // split in the graph; class-filter here selects which edges enter which projection).
    const isEng = str(r.relation_class) === 'engineering';
    if (forClass === 'epistemic' && isEng) continue; // §7 vector excludes engineering
    if (forClass === 'engineering' && !isEng) continue; // eng vector = engineering-only
    const src = str(r.source_claim_id);
    const tgt = str(r.target_claim_id);
    const rel = str(r.relation) ?? 'related';
    const mediator = (r.mediator ?? null) as EnrichEdge['mediator'];
    if (src === claimId && tgt) {
      const neighborText = textById.get(tgt);
      if (neighborText) edges.push({ relation: rel, direction: 'out', neighborText, mediator });
    } else if (tgt === claimId && src) {
      const neighborText = textById.get(src);
      if (neighborText) edges.push({ relation: rel, direction: 'in', neighborText, mediator });
    }
  }
  return edges;
}

export function makeVectorizeAndStore(embed: Embed, recordSchemas: SchemaMap = {}): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'vectorize-and-store',
      version: 'v1',
      kind: 'state',
      goal: 'embed and upsert vectors for committed records that declare a vector schema (no-op when none)',
      access: [],
      effects: ['vector'],
      determinism: 'model-dependent',
    },
    async ({ inputs, ctx }) => {
      const records = committedRecords(inputs.committed);
      // §12.7: a record type is vectorizable iff its record_schema declares a `vector` block.
      const targets = records.filter((w) => recordSchemas[w.record_type]?.vector);
      if (targets.length === 0) {
        return { control: 'returned', outputs: { vector_ids: [] } }; // RETURN / no vectorizable record → no-op
      }
      // neighbour-text lookup for {{edges}} enrichment (all committed claims).
      const textById = new Map<string, string>();
      for (const w of records) {
        const id = str(w.record.id);
        const content = w.record.content as Record<string, unknown> | undefined;
        const text = str(content?.text);
        if (id && text) textById.set(id, text);
      }
      const write = ctx.write('vector');
      const vector_ids: string[] = [];
      for (const t of targets) {
        const rec = t.record;
        const id = str(rec.id);
        if (!id) continue;
        const vectorSchema = recordSchemas[t.record_type]!.vector!;
        const content = (rec.content ?? {}) as Record<string, unknown>;
        // Computed enrichment (mirrors buildClaimProjection): run-context + 1-hop edges.
        const cycleType =
          str((rec.cycle_context as Record<string, unknown> | undefined)?.cycle_type) ??
          str(rec.cycle_type);
        const run = renderRunContext(str(rec.run_id), cycleType);
        const edges = renderEdges(edgesFor(id, records, textById, 'epistemic'));
        const engEdgesList = edgesFor(id, records, textById, 'engineering');
        // Flat projection+payload source: record top-level (eied denorms) + content fields.
        const flat: Record<string, unknown> = {
          text: str(content.text) ?? '',
          caveats: str(content.stated_scope_caveats) ?? '',
          modality: content.modality ?? null,
          claim_type: content.claim_type ?? null,
          claim_status: rec.claim_status ?? content.claim_status ?? null,
          verification_outcome: rec.verification_outcome ?? null,
          attester_id: rec.attester_id ?? null,
          run_id: rec.run_id ?? null,
          is_superseded: rec.is_superseded ?? false,
          attested_at: rec.attested_at ?? null,
        };
        const emb = buildEmbed(flat, vectorSchema, { run, edges });
        if (!emb.text.trim()) continue; // empty projection → nothing to embed
        const vector = await embed(emb.text);
        // §12.9 P3: a SECOND projection over the ENGINEERING edges → the gemini_eng vector. GATED by
        // LAYER2_ENG_VECTOR: the Qdrant collection must have the gemini_eng named vector FIRST (the
        // recreate schema-op), so the whole feature is inert until that op enables the flag — this makes
        // the code safe to deploy at any time. When enabled it is unconditional (every claim gets it;
        // the cost-skip for non-engineering claims is a deferred post-wave optimization).
        // is_engineering_connected marks claims with ≥1 ENG_* edge so eng-search read-filters to real
        // engineering approaches (not merely text-similar claims).
        let vectorEng: number[] | undefined;
        if (process.env.LAYER2_ENG_VECTOR === 'true') {
          const embEng = buildEmbed(flat, vectorSchema, { run, edges: renderEdges(engEdgesList) });
          vectorEng = await embed(embEng.text);
        }
        const vecId = `vec:${id}`;
        // Hand the embedded vector(s) + schema payload to the injected vector store; the
        // store-provider adds the computed ClaimPointPayload fields and upserts to Qdrant.
        await write.put(vecId, {
          id: vecId,
          ref: id,
          vector,
          vector_eng: vectorEng,
          is_engineering_connected: engEdgesList.length > 0,
          payload: emb.payload,
          text: emb.text,
          models: emb.models,
          namespace: 'layer2_claims',
        });
        vector_ids.push(vecId);
      }
      return { outputs: { vector_ids } };
    },
  );
}
