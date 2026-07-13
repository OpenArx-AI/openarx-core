// ── embed adapter (§12.7 · schema-driven · I3) ───────────────────────────────
//
// Turns a record + its `vector` schema block into the embed input (projection TEXT),
// the Qdrant payload, and the model list. Two-part `{{field}}` DSL (contracts 0218 Q2):
//   • DIRECT substitution for record fields — `{{text}}`, `{{caveats}}`.
//   • COMPUTED context-enrichment for `{{run}}` / `{{edges}}` — these are NOT plain record
//     fields; they are computed from the run-context + the claim's relations (reuse the
//     existing buildClaimProjection logic). The caller supplies them via `computed`; the
//     renderer merges { ...record, ...computed } so both kinds resolve uniformly.
//
// I3 (GO vs RETURN): only GO produces a vector — a RETURN emits only a checkpoint_return
// activity, never a claim or a vector. That is enforced upstream in the write-set
// (write-graph-records); this adapter is only invoked for the records that get embedded.
//
// Pure — no I/O, no embedding call. The interpreter's vectorize-and-store consumes this.

export interface VectorSchema {
  projection?: string;
  payload?: string[];
  payload_indexed?: { keyword?: string[]; bool?: string[] };
  models?: string[];
}

export interface EmbedOutput {
  /** the projection text fed to the embedding model(s). */
  text: string;
  /** the Qdrant point payload (schema `payload` fields, present-only). */
  payload: Record<string, unknown>;
  /** named vectors to compute (schema `models`, e.g. gemini + specter2). */
  models: string[];
}

// ── computed context-enrichment for {{run}} / {{edges}} (§5.4.2) ───────────────
// These are NOT plain record fields — they are computed from the run-context + the
// claim's 1-hop relations. This mirrors @openarx/api buildClaimProjection's LOGIC
// (same deterministic phrasing/shape), reimplemented here because @openarx/methodist
// is a PURE package (no @openarx/api dep). The caller (vectorize-and-store) computes
// these from the committed write-set and passes them to buildEmbed via `computed`.

/** One 1-hop relation, viewed FROM this claim (mirror of api ProjectionEdge). */
export interface EnrichEdge {
  relation: string;
  /** 'out' = this claim is the SOURCE of the edge; 'in' = it is the TARGET. */
  direction: 'out' | 'in';
  /** content.text of the claim on the other end. */
  neighborText: string;
  mediator?: { variable?: string; condition?: string } | null;
}

const NEIGHBOR_TEXT_MAX = 240;

function trimQuote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= NEIGHBOR_TEXT_MAX ? t : `${t.slice(0, NEIGHBOR_TEXT_MAX - 1)}…`;
}

/** `{{run}}` value: the run/cycle context sentence (empty string when no runId). */
export function renderRunContext(runId: string | null | undefined, cycleType?: string | null): string {
  if (!runId) return '';
  return `Run ${runId}${cycleType ? ` (cycle ${cycleType})` : ''}.`;
}

/** Deterministic phrase for one edge, viewed from this claim (mirror of api edgePhrase). */
function edgePhrase(e: EnrichEdge): string {
  const quoted = `"${trimQuote(e.neighborText)}"`;
  const mediator =
    e.mediator && (e.mediator.variable || e.mediator.condition)
      ? ` (given ${[e.mediator.variable, e.mediator.condition].filter(Boolean).join(': ')})`
      : '';
  const rel = e.relation;
  if (e.direction === 'out') {
    switch (rel) {
      case 'support': return `It supports: ${quoted}.`;
      case 'extend': return `It extends: ${quoted}.`;
      case 'qualify': return `It qualifies${mediator}: ${quoted}.`;
      case 'refute': return `It disputes: ${quoted}.`;
      case 'background': return `It gives background for: ${quoted}.`;
      case 'shared_evidence': return `It shares evidence with: ${quoted}.`;
      default: return `It relates (${rel}) to: ${quoted}.`;
    }
  }
  switch (rel) {
    case 'support': return `It is supported by: ${quoted}.`;
    case 'extend': return `It is extended by: ${quoted}.`;
    case 'qualify': return `It is qualified${mediator} by: ${quoted}.`;
    case 'refute': return `It is disputed by: ${quoted}.`;
    case 'background': return `It has background from: ${quoted}.`;
    case 'shared_evidence': return `It shares evidence with: ${quoted}.`;
    default: return `It is related (${rel}) from: ${quoted}.`;
  }
}

/** `{{edges}}` value: the joined 1-hop edge phrases (edges pre-sorted by the caller). */
export function renderEdges(edges: EnrichEdge[]): string {
  return edges.map(edgePhrase).join(' ');
}

/** `{{field}}` renderer — substitutes `{{key}}` with String(context[key]); missing → ''. */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = context[key];
    return v == null ? '' : String(v);
  });
}

/** Render the projection. `computed` carries the enriched {{run}}/{{edges}} (Q2). */
export function embedProjection(
  record: Record<string, unknown>,
  vectorSchema: VectorSchema | undefined,
  computed: Record<string, unknown> = {},
): string {
  if (!vectorSchema?.projection) return '';
  return renderTemplate(vectorSchema.projection, { ...record, ...computed });
}

/** Pick the schema `payload` fields (present-only) → the Qdrant point payload. */
export function embedPayload(
  record: Record<string, unknown>,
  vectorSchema: VectorSchema | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of vectorSchema?.payload ?? []) {
    if (record[f] !== undefined) out[f] = record[f];
  }
  return out;
}

/** Full embed output: projection text + payload + models. */
export function buildEmbed(
  record: Record<string, unknown>,
  vectorSchema: VectorSchema | undefined,
  computed: Record<string, unknown> = {},
): EmbedOutput {
  return {
    text: embedProjection(record, vectorSchema, computed),
    payload: embedPayload(record, vectorSchema),
    models: vectorSchema?.models ?? [],
  };
}
