/**
 * §12.9 P3 schema-op — add the `gemini_eng` named vector to Qdrant `layer2_claims`.
 *
 * Qdrant 1.17 cannot add a dense named vector to a live collection, so the collection
 * is RECREATED. gemini + specter2 are PRESERVED BYTE-EXACT (scroll with_vector → re-upsert
 * the exact bytes). Only the NEW gemini_eng vector is computed, and ONLY for eng-connected
 * claims (source/target of a relation_class=engineering edge). Non-eng points carry NO
 * gemini_eng: eng-search filters is_engineering_connected=true, so a point that lacks the
 * eng vector is never queried by it (Qdrant allows a point to omit a named vector).
 *
 * SAFETY:
 *  - HARDCODED to `layer2_claims` (Layer2VectorStore.LAYER2_COLLECTION). No code path in
 *    this script names `chunks` — that collection is structurally untouchable here.
 *  - Two stages. `verify` is NON-DESTRUCTIVE: scroll+backup EVERY point to a local file,
 *    read the graph, reconstruct the base (§7/epistemic) projection with the deployed
 *    write-path logic, report the text_hash match (validates reconstruction fidelity vs
 *    ground truth) + count eng-connected claims. GATE-A: every point must carry a gemini
 *    vector (else the backup is not a complete restore source → do NOT execute).
 *  - `execute` requires the backup file AND that every backed-up point has a gemini vector;
 *    it embeds the gemini_eng vectors FIRST (a failed embed aborts before anything
 *    destructive), then drops→recreates(3 vectors)→re-upserts from the backup→reports
 *    verify-after. Re-runnable (upsert is idempotent by point-id). The manual Qdrant
 *    snapshot taken before the drop is the ultimate rollback.
 *
 * Run ON S1 with the prod .env sourced (Qdrant vSwitch + Neo4j loopback + embed-service):
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/layer2-eng-vector-migrate.ts verify
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/layer2-eng-vector-migrate.ts execute
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  EmbedClient,
  Layer2VectorStore,
  closeNeo4j,
  projectionTextHash,
  type ClaimPointPayload,
} from '@openarx/api';
// Shared Neo4j projection reconstruction (identical logic to the Scope-B qwen backfill).
import { loadGraph, edgesFor, project } from './layer2-projection-reader.js';

// Default is derived from HOME rather than written out, so the deployment's directory layout does
// not travel with the source. Behaviour is unchanged where HOME is the service account's home.
const BACKUP = process.env.LAYER2_BACKUP ?? `${process.env.HOME ?? '.'}/data/layer2_claims_backup.json`;
const EMBED_MODEL = 'gemini-embedding-2-preview';

interface BackupPoint {
  id: string | number;
  vector: Record<string, number[]>;
  payload: ClaimPointPayload;
}

async function verify(): Promise<void> {
  const store = new Layer2VectorStore();
  const points = (await store.scrollAllWithVectors()) as BackupPoint[];
  const missingGemini = points.filter((p) => !Array.isArray(p.vector?.gemini));
  writeFileSync(BACKUP, JSON.stringify(points));

  const { claims, rels, engConnected } = await loadGraph();

  let match = 0;
  let mismatch = 0;
  let zMatch = 0;
  let zTotal = 0;
  let noGraph = 0;
  for (const p of points) {
    const cid = p.payload.claim_id;
    const c = claims.get(cid);
    if (!c) {
      noGraph++;
      continue;
    }
    const eEdges = edgesFor(cid, rels, claims, 'epistemic');
    const h = projectionTextHash(project(c, eEdges));
    if (h === p.payload.text_hash) match++;
    else mismatch++;
    if (eEdges.length === 0) {
      zTotal++;
      if (h === p.payload.text_hash) zMatch++;
    }
  }

  console.log(
    JSON.stringify(
      {
        stage: 'verify',
        points: points.length,
        missingGemini: missingGemini.length,
        backupWritten: BACKUP,
        graphClaims: claims.size,
        engConnectedClaims: engConnected.size,
        baseHashMatch: match,
        baseHashMismatch: mismatch,
        zeroEpistemicEdge: { match: zMatch, total: zTotal },
        pointsWithoutGraphClaim: noGraph,
      },
      null,
      2,
    ),
  );
  console.log(
    missingGemini.length === 0
      ? 'GATE-A OK: every point carries a gemini vector — backup is a complete restore source.'
      : `GATE-A FAIL: ${missingGemini.length} points missing gemini — DO NOT execute.`,
  );
  await closeNeo4j();
  process.exit(0);
}

async function execute(): Promise<void> {
  if (!existsSync(BACKUP)) throw new Error(`backup file missing (${BACKUP}) — run verify first`);
  const points = JSON.parse(readFileSync(BACKUP, 'utf8')) as BackupPoint[];
  const missingGemini = points.filter((p) => !Array.isArray(p.vector?.gemini));
  if (missingGemini.length > 0) {
    throw new Error(
      `backup incomplete: ${missingGemini.length} points missing gemini — refusing to drop`,
    );
  }

  const { claims, rels, engConnected } = await loadGraph();

  // Embed gemini_eng for eng-connected claims BEFORE any destructive op — a failed embed
  // aborts here, before the drop, so the collection is never left short of its old bytes.
  const embedClient = new EmbedClient({
    url: process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    secret: process.env.CORE_INTERNAL_SECRET ?? '',
  });
  const engVec = new Map<string, number[]>();
  for (const cid of engConnected) {
    const c = claims.get(cid);
    if (!c) continue;
    const proj = project(c, edgesFor(cid, rels, claims, 'engineering'));
    const r = await embedClient.callEmbed([proj], EMBED_MODEL);
    const v = r.vectors[0];
    if (!Array.isArray(v) || v.length === 0)
      throw new Error(`eng embed failed for ${cid} — abort before drop`);
    engVec.set(cid, v);
  }
  console.log(
    `precomputed gemini_eng for ${engVec.size} eng-connected claims (of ${engConnected.size} eng-connected)`,
  );

  // ── DESTRUCTIVE from here ── the recreate needs the eng-vector schema, gated by the flag.
  process.env.LAYER2_ENG_VECTOR = 'true';
  const store = new Layer2VectorStore();
  await store.dropCollection();
  await store.ensureCollection(); // recreates layer2_claims: gemini + specter2 + gemini_eng + all payload indexes
  console.log('dropped + recreated layer2_claims (3 named vectors + payload indexes)');

  let n = 0;
  for (const p of points) {
    const cid = p.payload.claim_id;
    const vectors: { gemini: number[]; specter2?: number[]; gemini_eng?: number[] } = {
      gemini: p.vector.gemini,
    };
    if (Array.isArray(p.vector.specter2)) vectors.specter2 = p.vector.specter2;
    if (engConnected.has(cid) && engVec.has(cid)) vectors.gemini_eng = engVec.get(cid);
    const payload: ClaimPointPayload = {
      ...p.payload,
      is_engineering_connected: engConnected.has(cid),
    };
    await store.upsertClaimPoint(cid, vectors, payload);
    n++;
    if (n % 100 === 0) console.log(`backfilled ${n}/${points.length}`);
  }

  const countAfter = await store.countPoints();
  console.log(
    JSON.stringify(
      {
        stage: 'execute',
        backfilled: n,
        expected: points.length,
        countAfter,
        engPointsWithEngVector: [...engConnected].filter((c) => engVec.has(c)).length,
      },
      null,
      2,
    ),
  );
  console.log(
    countAfter === points.length
      ? 'VERIFY-AFTER OK: count matches the backup.'
      : `VERIFY-AFTER MISMATCH: countAfter=${countAfter} expected=${points.length} — investigate.`,
  );
  await closeNeo4j();
  process.exit(0);
}

const stage = process.argv[2];
if (stage === 'verify') {
  void verify().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else if (stage === 'execute') {
  void execute().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error('usage: layer2-eng-vector-migrate.ts <verify|execute>');
  process.exit(1);
}
