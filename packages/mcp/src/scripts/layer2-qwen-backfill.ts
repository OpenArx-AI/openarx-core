/**
 * Scope-B (epic openarx-lsqk / lsqk.17) — populate the layer2_claims alt-model 768 slot
 * (physical named vector "specter2", now holding qwen) with qwen3-embedding-8b, over the
 * SAME §5.4.2 scientific (§7/epistemic) projection the `gemini` vector uses.
 *
 * Contracts I10 — QWEN-ONLY. This reads the current Neo4j graph, rebuilds each claim's
 * scientific projection (shared layer2-projection-reader: identical template / edge-selection /
 * deterministic sort as the §12.9 P3 eng-vector migration), embeds it with qwen via the
 * embed-service, and writes ONLY the 768 named vector via a vectors-only PUT. gemini and
 * gemini_eng are NEVER touched; no payload change; no collection recreate (the 768 slot
 * already exists in `layer2_claims`, just empty).
 *
 * FORCE by default: every projectable claim is (re-)embedded regardless of the stored gemini
 * text_hash, so the empty slot is fully filled. --skip-existing resumes cheaply, skipping
 * points that already carry a 768 vector (upsert is idempotent by point-id, so a re-run is
 * always safe).
 *
 * DRIFT is measured, not acted on. `driftCount` = claims whose CURRENT reconstructed projection
 * hash != the stored gemini text_hash — the I10 graph-drift signal for the methodist's B2
 * re-validation. gemini stays on its at-write-time projection; qwen embeds the current one
 * (tolerated per I10). `zeroEdge` reports the order-independent subset (0 epistemic edges) as a
 * clean drift measure (with >1 edge, the non-recoverable original write-set order also perturbs
 * the hash — same caveat as the eng-migration's baseHashMismatch).
 *
 * Run ON S1 with the prod .env sourced (Qdrant vSwitch + Neo4j loopback + embed-service):
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/layer2-qwen-backfill.ts --dry-run
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/layer2-qwen-backfill.ts --limit 20
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/layer2-qwen-backfill.ts
 */
import {
  EmbedClient,
  Layer2VectorStore,
  LAYER2_COLLECTION,
  closeNeo4j,
  projectionTextHash,
} from '@openarx/api';
import { loadGraph, edgesFor, project } from './layer2-projection-reader.js';

const QWEN_MODEL = 'qwen3-embedding-8b';
const QWEN_DIM = 768;

interface Args {
  dryRun: boolean;
  limit: number | null;
  concurrency: number;
  batchSize: number;
  skipExisting: boolean;
}

function parseArgs(argv: string[]): Args {
  const has = (f: string): boolean => argv.includes(f);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (f: string, d: number | null): number | null => {
    const v = val(f);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} must be a positive number`);
    return n;
  };
  return {
    dryRun: has('--dry-run'),
    limit: num('--limit', null),
    concurrency: num('--concurrency', 6) ?? 6,
    batchSize: num('--batch-size', 16) ?? 16,
    skipExisting: has('--skip-existing'),
  };
}

async function retry<T>(fn: () => Promise<T>, label: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = Math.min(8000, 500 * 2 ** attempt);
      console.error(
        `[retry] ${label} attempt ${attempt + 1} failed: ${(err as Error).message} — sleeping ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Vectors-only PUT of the 768 slot (named "specter2", now qwen). HARDCODED to
 *  layer2_claims — this script cannot target any other collection. Touches ONLY the
 *  specter2 named vector: gemini / gemini_eng / payload are left byte-exact (I10). */
async function upsertQwenVectors(
  points: Array<{ id: string | number; vector: number[] }>,
): Promise<void> {
  if (points.length === 0) return;
  const base = (process.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/+$/, '');
  const apiKey = process.env.QDRANT_API_KEY ?? '';
  const body = { points: points.map((p) => ({ id: p.id, vector: { specter2: p.vector } })) };
  const resp = await fetch(`${base}/collections/${LAYER2_COLLECTION}/points/vectors?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`qdrant vectors ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { status?: string; result?: { status?: string } };
  const status = data.result?.status ?? data.status;
  if (status && status !== 'acknowledged' && status !== 'completed') {
    throw new Error(`qdrant vectors unexpected status: ${status}`);
  }
}

interface WorkItem {
  pointId: string | number;
  claimId: string;
  proj: string;
  drift: boolean; // reconstructed projection hash != stored gemini text_hash
  zeroEdge: boolean; // 0 epistemic edges → hash is order-independent (clean drift signal)
  hasQwen: boolean; // point already carries a non-empty 768 vector
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new Layer2VectorStore();

  // 1. Scroll existing points (claim_id, stored gemini text_hash, whether a 768 vector exists).
  const points = await store.scrollAllWithVectors();
  // 2. Load the canonical graph once (Neo4j).
  const { claims, rels } = await loadGraph();

  // 3. Build the work-list: reconstruct each claim's scientific projection + measure drift.
  const work: WorkItem[] = [];
  let noGraphClaim = 0;
  for (const p of points) {
    const claimId = p.payload.claim_id;
    const c = claims.get(claimId);
    if (!c) {
      noGraphClaim++; // Qdrant point whose claim node is gone from the graph — cannot project
      continue;
    }
    const eEdges = edgesFor(claimId, rels, claims, 'epistemic');
    const proj = project(c, eEdges);
    const specter2 = p.vector?.specter2;
    work.push({
      pointId: p.id,
      claimId,
      proj,
      drift: projectionTextHash(proj) !== p.payload.text_hash,
      zeroEdge: eEdges.length === 0,
      hasQwen: Array.isArray(specter2) && specter2.length > 0,
    });
  }

  const driftCount = work.filter((w) => w.drift).length;
  const zTotal = work.filter((w) => w.zeroEdge).length;
  const zMatch = work.filter((w) => w.zeroEdge && !w.drift).length;
  const alreadyQwen = work.filter((w) => w.hasQwen).length;

  // --skip-existing + --limit shape the TARGET set (drift is measured over the full set above).
  let targets = args.skipExisting ? work.filter((w) => !w.hasQwen) : work;
  if (args.limit !== null) targets = targets.slice(0, args.limit);

  console.log(
    JSON.stringify(
      {
        stage: args.dryRun ? 'dry-run' : 'backfill',
        qdrantPoints: points.length,
        graphClaims: claims.size,
        projectable: work.length,
        pointsWithoutGraphClaim: noGraphClaim,
        driftCount, // I10 graph-drift signal for methodist B2
        driftPct: work.length ? +((100 * driftCount) / work.length).toFixed(2) : 0,
        zeroEdge: { total: zTotal, hashMatch: zMatch }, // order-independent drift subset
        alreadyHave768: alreadyQwen,
        targets: targets.length,
        skipExisting: args.skipExisting,
        limit: args.limit,
      },
      null,
      2,
    ),
  );

  if (args.dryRun) {
    await closeNeo4j();
    process.exit(0);
  }

  // 4. Embed qwen + upsert the 768 slot, in batches with bounded concurrency.
  const embed = new EmbedClient({
    url: process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    secret: process.env.CORE_INTERNAL_SECRET ?? '',
    timeoutMs: 120_000,
  });

  const batches: WorkItem[][] = [];
  for (let i = 0; i < targets.length; i += args.batchSize) {
    batches.push(targets.slice(i, i + args.batchSize));
  }

  let done = 0;
  let cost = 0;
  let cursor = 0; // single-threaded ⇒ cursor++/done+=/cost+= are race-free across workers
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      const resp = await retry(
        () =>
          embed.callEmbed(
            batch.map((w) => w.proj),
            QWEN_MODEL,
            { bypassCache: true, allowFallback: true },
          ),
        `embed batch ${idx}`,
      );
      if (resp.vectors.length !== batch.length) {
        throw new Error(`embed returned ${resp.vectors.length} vectors for ${batch.length} texts`);
      }
      const upsertPoints = batch.map((w, j) => {
        const v = resp.vectors[j];
        if (!Array.isArray(v) || v.length !== QWEN_DIM) {
          throw new Error(`qwen vector dim ${v?.length ?? 0} != ${QWEN_DIM} for claim ${w.claimId}`);
        }
        return { id: w.pointId, vector: v };
      });
      await retry(() => upsertQwenVectors(upsertPoints), `upsert batch ${idx}`);
      cost += resp.cost ?? 0;
      done += batch.length;
      console.log(
        JSON.stringify({ progress: `${done}/${targets.length}`, batch: idx, costUsd: +cost.toFixed(4) }),
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, batches.length) }, () => worker()),
  );

  console.log(
    JSON.stringify(
      {
        stage: 'backfill-complete',
        embedded: done,
        targets: targets.length,
        driftCount,
        totalCostUsd: +cost.toFixed(4),
      },
      null,
      2,
    ),
  );
  await closeNeo4j();
  process.exit(0);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
