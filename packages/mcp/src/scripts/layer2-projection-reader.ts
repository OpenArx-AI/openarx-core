/**
 * Layer 2 claim-projection reconstruction from the Neo4j graph — the single source of
 * "rebuild the exact §5.4.2 embed projection for an EXISTING claim." Shared by the
 * §12.9 P3 eng-vector migration and the Scope-B qwen alt-vector backfill so both
 * reconstruct byte-identically (same template, same edge selection, same sort).
 *
 * The graph is Neo4j (PG layer2_* tables were dropped in migration 051). The live
 * write-path (@openarx/methodist vectorize-and-store) builds a claim's projection from
 * the run's in-memory committed records; here we reproduce that projection for an
 * already-stored claim by reading its 1-hop neighbourhood back out of the graph. The
 * per-run write-set order is NOT recoverable from the graph, so edges are deterministically
 * sorted — the reconstructed projection is reproducible, and any divergence from the stored
 * gemini text_hash is genuine graph-drift (edges added after the claim was first embedded),
 * quantified by the caller.
 */
import { getNeo4jDriver } from '@openarx/api';
import { renderRunContext, renderEdges, renderTemplate, type EnrichEdge } from '@openarx/methodist';

/** The deployed claim vector projection template (record_schemas.json → claim.vector.projection). */
export const TEMPLATE = '[Context] {{run}} {{edges}}\n[Claim] {{text}} {{caveats}}';

export interface ClaimRow {
  id: string;
  text: string;
  caveats: string;
  run_id: string | null;
  cycle_type: string | null;
}
export interface RelRow {
  source: string | null;
  target: string | null;
  relation: string;
  is_engineering: boolean;
  mediator: EnrichEdge['mediator'];
}

const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Load every claim + relation node from Neo4j (the canonical graph). Returns the claim
 *  rows keyed by id, the flat relation list, and the set of engineering-connected claim ids. */
export async function loadGraph(): Promise<{
  claims: Map<string, ClaimRow>;
  rels: RelRow[];
  engConnected: Set<string>;
}> {
  const session = getNeo4jDriver().session();
  try {
    const claims = new Map<string, ClaimRow>();
    const cr = await session.run('MATCH (c:claim) RETURN c._data AS data');
    for (const rec of cr.records) {
      const d = JSON.parse(rec.get('data') as string) as Record<string, unknown>;
      const id = s(d.id);
      if (!id) continue;
      const content = (d.content ?? {}) as Record<string, unknown>;
      const cycleCtx = (d.cycle_context ?? undefined) as Record<string, unknown> | undefined;
      claims.set(id, {
        id,
        text: s(content.text) ?? '',
        caveats: s(content.stated_scope_caveats) ?? '',
        run_id: s(d.run_id),
        cycle_type: s(cycleCtx?.cycle_type) ?? s(d.cycle_type),
      });
    }
    const rels: RelRow[] = [];
    const engConnected = new Set<string>();
    const rr = await session.run('MATCH (r:relation) RETURN r._data AS data');
    for (const rec of rr.records) {
      const d = JSON.parse(rec.get('data') as string) as Record<string, unknown>;
      const source = s(d.source_claim_id);
      const target = s(d.target_claim_id);
      const isEng = s(d.relation_class) === 'engineering';
      rels.push({
        source,
        target,
        relation: s(d.relation) ?? 'related',
        is_engineering: isEng,
        mediator: (d.mediator ?? null) as EnrichEdge['mediator'],
      });
      if (isEng) {
        if (source) engConnected.add(source);
        if (target) engConnected.add(target);
      }
    }
    return { claims, rels, engConnected };
  } finally {
    await session.close();
  }
}

/** 1-hop edges for a claim, filtered by class — mirrors vectorize-and-store.edgesFor,
 *  but deterministically sorted (the original per-run write-set order is not recoverable
 *  from the graph; a stable sort makes the projection reproducible). */
export function edgesFor(
  claimId: string,
  rels: RelRow[],
  claims: Map<string, ClaimRow>,
  forClass: 'epistemic' | 'engineering',
): EnrichEdge[] {
  const edges: EnrichEdge[] = [];
  for (const r of rels) {
    if (forClass === 'epistemic' && r.is_engineering) continue;
    if (forClass === 'engineering' && !r.is_engineering) continue;
    if (r.source === claimId && r.target) {
      const n = claims.get(r.target);
      if (n)
        edges.push({
          relation: r.relation,
          direction: 'out',
          neighborText: n.text,
          mediator: r.mediator,
        });
    } else if (r.target === claimId && r.source) {
      const n = claims.get(r.source);
      if (n)
        edges.push({
          relation: r.relation,
          direction: 'in',
          neighborText: n.text,
          mediator: r.mediator,
        });
    }
  }
  edges.sort((a, b) =>
    `${a.direction}|${a.relation}|${a.neighborText}`.localeCompare(
      `${b.direction}|${b.relation}|${b.neighborText}`,
    ),
  );
  return edges;
}

/** Render the §5.4.2 v1 projection for a claim + its class-filtered edges. */
export function project(c: ClaimRow, edges: EnrichEdge[]): string {
  return renderTemplate(TEMPLATE, {
    text: c.text,
    caveats: c.caveats,
    run: renderRunContext(c.run_id, c.cycle_type),
    edges: renderEdges(edges),
  });
}
