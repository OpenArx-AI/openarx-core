/**
 * reembed-stale-768 — replace leftover OLD specter2 vectors in the 768 slot with qwen
 * (epic openarx-lsqk / bead openarx-iyg9).
 *
 * WHY THIS EXISTS: the Stage-1 bulk selects documents with `status='ready'`, so chunks belonging
 * to documents in other states (failed, downloaded) were never candidates — yet their PREVIOUSLY
 * written specter2 vectors stayed in the searchable set, because the Qdrant search guard filters
 * only on `is_latest` / `deleted` and NOT on the parent document's status. Measured: a query
 * embedded with qwen scored against such a vector gives cos ≈ 0.02 — a plausible-looking but
 * meaningless number with no error signal, i.e. exactly the silently-wrong outcome the operational
 * policy forbids. This script finishes the migration for those chunks.
 *
 * Scope = chunks that are IN the live search space and were never touched by the qwen pass:
 *   recovery_status IS NULL  AND  is_latest  AND  status IN ('indexed','embedded')  AND a point id.
 * Chunks with status='pending_embed' are deliberately excluded: they have a reserved point id but
 * no point in Qdrant (verified), so they are an honest coverage gap, not a wrong vector.
 *
 * Writes ONLY the 768 named vector ("specter2", holding qwen) via a vectors-only PUT — gemini and
 * the payload are left byte-exact. Then marks the chunk `recovery_status='reembed_only'` (accurate:
 * embedded from stored content, no text recovery attempted). It deliberately does NOT set
 * documents.qwen_reembed_at for non-ready documents: if such a document is ever repaired and
 * re-parsed it must be re-processed, and that marker would suppress it.
 *
 *   pnpm --filter @openarx/ingest run reembed-stale-768 -- --dry-run
 *   pnpm --filter @openarx/ingest run reembed-stale-768
 */
import { query } from '@openarx/api';
import { createChildLogger } from '../lib/logger.js';
import { buildEmbedInput, type MigrationChunkContext } from './migrate-embeddings-lib.js';
import { capEmbedInput } from './embed-input-cap.js';

const log = createChildLogger('reembed-stale-768');
const QWEN_MODEL = 'qwen3-embedding-8b';
const QWEN_DIM = 768;

interface Args {
  dryRun: boolean;
  batchSize: number;
  limit: number | null;
  maxEmbedTokens: number;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (f: string, d: number | null): number | null => {
    const v = get(f);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} must be a positive number`);
    return n;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    batchSize: num('--batch-size', 32) ?? 32,
    limit: num('--limit', null),
    maxEmbedTokens: num('--max-embed-tokens', 1024) ?? 1024,
  };
}

interface Row {
  id: string;
  qdrant_point_id: string;
  content: string;
  context: MigrationChunkContext;
  doc_status: string;
}

async function embedBatch(texts: string[]): Promise<{ vectors: number[][]; cost: number }> {
  const url = process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400';
  const resp = await fetch(`${url}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.CORE_INTERNAL_SECRET ?? '',
    },
    // allowFallback: the rented GPU pool is gone, so this must be served by OpenRouter.
    body: JSON.stringify({ texts, model: QWEN_MODEL, bypassCache: true, allowFallback: true }),
  });
  if (!resp.ok) throw new Error(`embed-service ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { vectors: number[][]; cost?: number };
  return { vectors: data.vectors, cost: data.cost ?? 0 };
}

/** Which of these point ids actually exist in Qdrant (a reserved id is not a point). */
async function existingPoints(ids: string[]): Promise<Set<string>> {
  const base = (process.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/+$/, '');
  const resp = await fetch(`${base}/collections/chunks/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.QDRANT_API_KEY ?? '' },
    body: JSON.stringify({ ids, with_payload: false, with_vector: false }),
  });
  if (!resp.ok) throw new Error(`qdrant retrieve ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = (await resp.json()) as { result: Array<{ id: string }> };
  return new Set(data.result.map((p) => String(p.id)));
}

/** Vectors-only PUT of the 768 slot. gemini + payload untouched. */
async function putQwenVectors(points: Array<{ id: string; vector: number[] }>): Promise<void> {
  if (points.length === 0) return;
  const base = (process.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/+$/, '');
  const resp = await fetch(`${base}/collections/chunks/points/vectors?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.QDRANT_API_KEY ?? '' },
    body: JSON.stringify({ points: points.map((p) => ({ id: p.id, vector: { specter2: p.vector } })) }),
  });
  if (!resp.ok) throw new Error(`qdrant vectors ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log.info({ args }, 'start');

  const rows = (
    await query<Row>(
      `SELECT c.id::text AS id, c.qdrant_point_id::text AS qdrant_point_id, c.content,
              c.context, d.status AS doc_status
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.recovery_status IS NULL
          AND c.qdrant_point_id IS NOT NULL
          AND c.is_latest = TRUE
          AND c.status IN ('indexed', 'embedded')
        ORDER BY c.id
        ${args.limit !== null ? `LIMIT ${args.limit}` : ''}`,
    )
  ).rows;

  const byDocStatus = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.doc_status] = (acc[r.doc_status] ?? 0) + 1;
    return acc;
  }, {});
  log.info({ candidates: rows.length, byDocStatus }, 'scope');
  if (args.dryRun || rows.length === 0) {
    log.info({ dryRun: args.dryRun }, 'nothing written');
    process.exit(0);
  }

  let embedded = 0;
  let skippedNoPoint = 0;
  let truncated = 0;
  let cost = 0;
  for (let i = 0; i < rows.length; i += args.batchSize) {
    const batch = rows.slice(i, i + args.batchSize);
    const present = await existingPoints(batch.map((r) => r.qdrant_point_id));
    const live = batch.filter((r) => present.has(r.qdrant_point_id));
    skippedNoPoint += batch.length - live.length;
    if (live.length === 0) continue;

    const texts = live.map((r) => {
      const capped = capEmbedInput(
        buildEmbedInput({ id: r.id, qdrant_point_id: r.qdrant_point_id, content: r.content, context: r.context }),
        args.maxEmbedTokens,
      );
      if (capped.truncated) truncated++;
      return capped.text;
    });
    const { vectors, cost: batchCost } = await embedBatch(texts);
    if (vectors.length !== live.length) {
      throw new Error(`embed returned ${vectors.length} vectors for ${live.length} texts`);
    }
    vectors.forEach((v, j) => {
      if (!Array.isArray(v) || v.length !== QWEN_DIM) {
        throw new Error(`qwen vector dim ${v?.length ?? 0} != ${QWEN_DIM} for chunk ${live[j].id}`);
      }
    });
    await putQwenVectors(live.map((r, j) => ({ id: r.qdrant_point_id, vector: vectors[j] })));
    // Mark only AFTER the vector is durably written (wait=true), so a crash can never leave a
    // chunk marked processed with a stale vector.
    await query(`UPDATE chunks SET recovery_status = 'reembed_only' WHERE id = ANY($1::uuid[])`, [
      live.map((r) => r.id),
    ]);
    cost += batchCost;
    embedded += live.length;
    log.info({ embedded, of: rows.length, costUsd: +cost.toFixed(5) }, 'progress');
  }

  log.info(
    { embedded, skippedNoPoint, truncatedInputs: truncated, costUsd: +cost.toFixed(5) },
    'reembed-stale-768 complete',
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'reembed-stale-768 failed');
  process.exit(1);
});
