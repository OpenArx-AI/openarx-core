// ── methodist graph rollup (Console 694n) ────────────────────────────────────
//
// Hourly snapshot of the HEAVY Neo4j claim breakdowns (B2) into the PG table
// methodist_graph_rollup, so Console reads a pre-aggregated batch (max(rolled_at))
// instead of scanning Neo4j per request. The CHEAP counts (node-label / rel-type /
// Qdrant) are served live via /methodist-graph-counts and are NOT rolled up here.
//
// v1 reads every claim's _data blob to aggregate claim_type / modality / verified
// (those live inside content, not as indexed scalars); claim_status + attester_id
// are indexed. At tens-of-millions scale this full scan is the reason it's a periodic
// rollup, not a live query — tighten with native indexed aggregation if it gets hot.
// methodology_version slicing is a follow-up (needs a claim.run_id → run join).

import { getNeo4jDriver, query } from '@openarx/api';

interface Agg {
  count: number;
  verified: number;
}

const POLL_MS = 60 * 60 * 1000; // hourly
let timer: NodeJS.Timeout | null = null;

/** Run one rollup: scan claims in Neo4j, aggregate, write a fresh batch to PG. */
export async function runMethodistGraphRollup(): Promise<{ rows: number; claims: number }> {
  const session = getNeo4jDriver().session();
  let records: Array<{ data: string | null; status: string | null; attester: string | null }>;
  try {
    const r = await session.run('MATCH (n:claim) RETURN n._data AS data, n.claim_status AS status, n.attester_id AS attester');
    records = r.records.map((rec) => ({
      data: rec.get('data') as string | null,
      status: rec.get('status') as string | null,
      attester: rec.get('attester') as string | null,
    }));
  } finally {
    await session.close();
  }

  const byType = new Map<string, Agg>();
  const byStatus = new Map<string, Agg>();
  const byModality = new Map<string, Agg>();
  const byAttester = new Map<string, number>();
  const bump = (m: Map<string, Agg>, key: string, verified: boolean): void => {
    const e = m.get(key) ?? { count: 0, verified: 0 };
    e.count += 1;
    if (verified) e.verified += 1;
    m.set(key, e);
  };

  for (const c of records) {
    let content: Record<string, unknown> = {};
    let verification: Record<string, unknown> = {};
    try {
      const d = c.data ? (JSON.parse(c.data) as Record<string, unknown>) : {};
      content = (d.content as Record<string, unknown>) ?? {};
      verification = (d.verification as Record<string, unknown>) ?? {};
    } catch {
      // malformed _data → count under 'null' buckets, uncounted verified
    }
    const verified = verification?.outcome === 'VERIFIED';
    bump(byType, typeof content.claim_type === 'string' ? content.claim_type : 'null', verified);
    bump(byStatus, c.status ?? (typeof content.claim_status === 'string' ? content.claim_status : 'null'), verified);
    bump(byModality, typeof content.modality === 'string' ? content.modality : 'null', verified);
    if (c.attester) byAttester.set(c.attester, (byAttester.get(c.attester) ?? 0) + 1);
  }

  // Flatten to tall rows: [dimension, bucket(null when 'null'), count, verified].
  const rows: Array<[string, string | null, number, number]> = [];
  const push = (dim: string, m: Map<string, Agg>): void => {
    for (const [k, v] of m) rows.push([dim, k === 'null' ? null : k, v.count, v.verified]);
  };
  push('claim_type', byType);
  push('claim_status', byStatus);
  push('modality', byModality);
  for (const [attester, count] of [...byAttester.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    rows.push(['top_attester', attester, count, 0]);
  }

  // One batch = one rolled_at (Console reads WHERE rolled_at = max(rolled_at)).
  const rolledAt = new Date().toISOString();
  for (const [dimension, bucket, count, verified] of rows) {
    await query(
      `INSERT INTO methodist_graph_rollup (rolled_at, dimension, bucket, count, verified_count)
       VALUES ($1,$2,$3,$4,$5)`,
      [rolledAt, dimension, bucket, count, verified],
    );
  }
  return { rows: rows.length, claims: records.length };
}

/** Start the hourly rollup timer (idempotent). Runs once ~30s after start, then hourly. */
export function startMethodistRollupTimer(): void {
  if (timer) return;
  const run = (): void => {
    void runMethodistGraphRollup()
      .then((r) => console.error(`[methodist-rollup] ${r.rows} rows from ${r.claims} claims`))
      .catch((e) => console.error('[methodist-rollup] error:', e instanceof Error ? e.message : e));
  };
  timer = setInterval(run, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const warmup = setTimeout(run, 30_000);
  if (typeof warmup.unref === 'function') warmup.unref();
  console.error(`[methodist-rollup] timer started (interval=${POLL_MS / 1000}s)`);
}
