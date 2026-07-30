// ── supersede derivation (openarx-z2bj) ──────────────────────────────────────
//
// A correction did not withdraw the thing it corrected. `is_superseded` is declared on claim nodes
// and read by every latest_only path, but NOTHING ever writes it: measured 2026-07-27, all 3357
// claims have it NULL while 10 claims declare `supersedes` in their record. So latest_only — a
// DEFAULT, described to wards as "you only get current versions" — filtered nothing, and the read
// surface answered is_superseded:false for records that were demonstrably superseded. A ward's
// correction sat in the graph for five days while another agent built on the version it replaced.
//
// The fix derives the answer from the act instead of trusting a cache of it. The act is the
// `supersedes` field the newer record carries; that record is immutable, so the derivation is
// correct for all history including the ten acts that already happened, and it needs no write to
// the live graph. (Precedent: run completion was moved off a recount over a mutable table onto the
// durable append-only version_closeout marker for the same reason.)
//
// NOTE on the shape: there is no SUPERSEDES edge in the graph — the relationship edge types are the
// §7 labels only. The fact lives as `"supersedes":"<full prefixed claim id>"` inside the newer
// claim's _data, so the match below is on that exact key/value pair rather than a loose substring,
// which would collide with any other mention of the same id.
import { getNeo4jDriver } from '@openarx/api';

/** How far a supersede chain is followed before the answer is called degraded. Chains are 1-2 long
 *  in practice; the cap exists so a cycle in the data cannot hang a read. */
const MAX_CHAIN_HOPS = 8;

export interface SupersedeHead {
  /** the current version to use — the head of the chain */
  id: string;
  /** true when at least one supersede was followed (content may differ from where we started) */
  followedChain: boolean;
  /** ★ two or more records supersede the same one: there is no single head. Both are returned and
   *  the caller must NOT pick one silently — a reader told "here are two competing corrections" can
   *  resolve it, a reader handed one of them and told nothing cannot. */
  ambiguous: boolean;
  /** every head found (one element unless ambiguous) */
  heads: string[];
  /** the chain was cut by the hop cap (cycle or implausible length) — the answer is degraded */
  degraded: boolean;
}

/** Which claims supersede each of the given ids? Returns id → [newer ids]; absent/empty means the
 *  claim is current. One query for the whole batch, so a page of results costs one round trip. */
/** Session source. Defaults to the live driver; tests pass a double so the derivation logic (chain,
 *  fork, cycle) can be exercised without a graph. */
export interface GraphSessionSource {
  session(): { run(cypher: string, params: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>; close(): Promise<unknown> };
}

export async function deriveSupersessors(
  ids: string[],
  driver?: GraphSessionSource,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return out;

  const session = (driver ?? (getNeo4jDriver() as unknown as GraphSessionSource)).session();
  try {
    const r = await session.run(
      `UNWIND $ids AS cid
       MATCH (newer:\`claim\`)
       WHERE newer._data CONTAINS ('"supersedes":"' + cid + '"')
       RETURN cid AS superseded, collect(newer.id) AS newer_ids`,
      { ids: unique },
    );
    for (const rec of r.records) {
      const superseded = rec.get('superseded') as string;
      const newerIds = (rec.get('newer_ids') as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      );
      // A record that supersedes itself is malformed data, not a chain — ignore it rather than
      // looping on it.
      const clean = newerIds.filter((v) => v !== superseded);
      if (clean.length > 0) out.set(superseded, clean);
    }
  } finally {
    await session.close();
  }
  return out;
}

/** Is this claim superseded? Convenience over deriveSupersessors for single-record paths. */
export async function isSuperseded(id: string, driver?: GraphSessionSource): Promise<boolean> {
  const m = await deriveSupersessors([id], driver);
  return (m.get(id)?.length ?? 0) > 0;
}

/** Follow the supersede chain from `id` to its current head.
 *
 *  Walks to the END of the chain, not one hop: if C supersedes A and A supersedes B, then asking
 *  about B must answer C. A one-hop answer would report A — quieter and worse than saying nothing,
 *  because A is itself already replaced.
 *
 *  On a fork the walk stops and reports every head it can see. Choosing between competing
 *  corrections is a judgement about the science, and the system is not entitled to make it silently.
 */
export async function resolveSupersedeHead(
  id: string,
  driver?: GraphSessionSource,
): Promise<SupersedeHead> {
  let current = id;
  let followed = false;
  const seen = new Set<string>([id]);

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    const newer = (await deriveSupersessors([current], driver)).get(current) ?? [];
    if (newer.length === 0) {
      return { id: current, followedChain: followed, ambiguous: false, heads: [current], degraded: false };
    }
    if (newer.length > 1) {
      // Resolve each branch to ITS head, so the caller is offered the current versions of the
      // competing corrections rather than their intermediate states.
      const heads = new Set<string>();
      for (const branch of newer) {
        if (seen.has(branch)) continue;
        const sub = await resolveSupersedeHead(branch, driver);
        for (const h of sub.heads) heads.add(h);
      }
      const list = [...heads];
      return {
        id: list[0] ?? current,
        followedChain: true,
        ambiguous: list.length > 1,
        heads: list.length > 0 ? list : [current],
        degraded: false,
      };
    }
    const next = newer[0];
    if (seen.has(next)) break; // cycle — stop and say the answer is degraded
    seen.add(next);
    current = next;
    followed = true;
  }
  // Cut by the cap or by a cycle: return what was reached and say so, rather than looping or
  // pretending the answer is clean.
  return { id: current, followedChain: followed, ambiguous: false, heads: [current], degraded: true };
}
