// ── Layer 2 semantic layer — enriched embed projection, v1 (pillar §5.4.2) ────
//
// Principle (Vlad): a claim's text carries meaning through its position in the
// graph; embedding bare text loses that position. The embedded payload is the
// claim text PLUS a deterministic context prefix assembled from the record's
// 1-hop graph surroundings. This is the Layer 2 analog of the document
// pipeline's Enrich stage.
//
// v1 = DETERMINISTIC TEMPLATE (reproducible, cheap; v2 LLM summarization is a
// future candidate, out of scope). The template below IS contract material
// (§5.4.2): PAYLOAD_SCHEMA_VERSION is stored on every index point; changing
// the template = bump the version = a reindex event.
//
// English-only by construction (§5.4.6 language canon).

export const PAYLOAD_SCHEMA_VERSION = 'v1';

/** Max characters of a neighbor claim's text quoted into the context prefix. */
const NEIGHBOR_TEXT_MAX = 160;

export interface ProjectionEdge {
  /** Relation type: support | extend | qualify | refute | background | shared_evidence | … */
  relation: string;
  /** 'out' = this claim is the SOURCE of the edge; 'in' = it is the TARGET. */
  direction: 'out' | 'in';
  /** content.text of the claim on the other end of the edge. */
  neighborText: string;
  /** qualify mediator, when present on the edge. */
  mediator?: { variable?: string; condition?: string } | null;
}

export interface ProjectionInput {
  text: string;
  statedScopeCaveats?: string | null;
  cycleType?: string | null;
  runId?: string | null;
  edges: ProjectionEdge[];
}

function trimQuote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= NEIGHBOR_TEXT_MAX ? t : `${t.slice(0, NEIGHBOR_TEXT_MAX - 1)}…`;
}

/** Deterministic phrase for one edge, viewed from this claim. */
function edgePhrase(e: ProjectionEdge): string {
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

/**
 * Build the v1 embedded text for a claim. Deterministic: same inputs (incl.
 * edge order — pass edges pre-sorted by the caller, e.g. attested_at,id) →
 * byte-identical output.
 *
 * Shape:
 *   [Context] Run <run_id> (cycle <n>). <edge phrases…>
 *   [Claim] <text> <caveats>
 */
export function buildClaimProjection(input: ProjectionInput): string {
  const ctx: string[] = [];
  if (input.runId) {
    ctx.push(`Run ${input.runId}${input.cycleType ? ` (cycle ${input.cycleType})` : ''}.`);
  }
  // dispute side signal comes through the refute phrasing (disputes / is
  // disputed by) — no separate field needed at v1.
  for (const e of input.edges) ctx.push(edgePhrase(e));

  const claimLine = [input.text.replace(/\s+/g, ' ').trim(), (input.statedScopeCaveats ?? '').trim()]
    .filter(Boolean)
    .join(' ');

  return ctx.length > 0
    ? `[Context] ${ctx.join(' ')}\n[Claim] ${claimLine}`
    : `[Claim] ${claimLine}`;
}
