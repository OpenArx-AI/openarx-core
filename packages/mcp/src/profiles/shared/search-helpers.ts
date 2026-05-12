/**
 * Search v2 (openarx-g8af) — shared helpers for hybrid / keyword / semantic
 * search tools. Three concerns live here:
 *
 *   1. Hydrate chunks.context from PG for legacy chunks that don't carry
 *      LLM markers in their Qdrant payload yet (pre-backfill state).
 *   2. Post-fetch filtering by contentType / entities (works regardless of
 *      whether Qdrant payload has markers — uses hydrated context).
 *   3. Detail-level response formatting (minimal / standard / full) with
 *      consistent shape across search, search_keyword, search_semantic.
 */

import { randomUUID } from 'node:crypto';
import type { Document, ChunkContext } from '@openarx/types';
import type { AppContext } from '../../context.js';
import { computeCanServeFile, truncateChunk } from './helpers.js';
import { getRedis } from '../../lib/redis.js';

const SEARCH_POOL_TTL_SEC = 300;
const SEARCH_POOL_KEY_PREFIX = 'search-pool:';

export type DetailLevel = 'minimal' | 'standard' | 'full';

export type DiversifyKey = 'document' | 'keyConcept' | 'contentType';

export interface RankedChunk {
  chunkId: string;
  documentId: string;
  content: string;
  context: ChunkContext;
  vectorScore: number;
  bm25Score: number;
  finalScore: number;
}

export interface ChunkContextFilters {
  contentType?: string[];
  entities?: string[];
}

const VALID_CONTENT_TYPES = new Set([
  'theoretical', 'methodology', 'experimental', 'results',
  'survey', 'background', 'other',
]);

/**
 * Hydrate ChunkContext from PG for chunks where Qdrant payload lacks
 * the LLM markers (summary/keyConcept/contentType/entities/selfContained).
 * Idempotent — only fills fields that are missing.
 *
 * Used as fallback while Qdrant payload backfill is pending. Costs a single
 * bulk SELECT keyed by chunk_id (~50ms for 50 ids).
 */
export async function hydrateChunkContexts(
  chunks: RankedChunk[],
  ctx: AppContext,
): Promise<RankedChunk[]> {
  const needsHydration = chunks.filter((c) =>
    c.context.summary === undefined &&
    c.context.keyConcept === undefined &&
    c.context.contentType === undefined &&
    c.context.entities === undefined &&
    c.context.selfContained === undefined,
  );
  if (needsHydration.length === 0) return chunks;

  const ids = needsHydration.map((c) => c.chunkId);
  const { rows } = await ctx.pool.query<{ id: string; context: ChunkContext }>(
    `SELECT id, context FROM chunks WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  const ctxById = new Map<string, ChunkContext>();
  for (const r of rows) ctxById.set(r.id, r.context);

  return chunks.map((c) => {
    const pgCtx = ctxById.get(c.chunkId);
    if (!pgCtx) return c;
    return {
      ...c,
      context: {
        ...c.context,
        summary: c.context.summary ?? pgCtx.summary,
        keyConcept: c.context.keyConcept ?? pgCtx.keyConcept,
        contentType: c.context.contentType ?? pgCtx.contentType,
        entities: c.context.entities ?? pgCtx.entities,
        selfContained: c.context.selfContained ?? pgCtx.selfContained,
      },
    };
  });
}

/**
 * Filter chunks by chunk-context fields. Both filters are AND-ed.
 *   contentType[] — chunk's contentType must match one of provided values
 *   entities[] — chunk's entities must contain ANY of the provided values
 *                (case-insensitive).
 *
 * Chunks lacking the relevant context field are excluded when that filter
 * is active (no false positives for missing data).
 */
export function applyChunkContextFilters(
  chunks: RankedChunk[],
  filters: ChunkContextFilters,
): RankedChunk[] {
  const ctSet = filters.contentType && filters.contentType.length > 0
    ? new Set(filters.contentType.map((s) => s.toLowerCase()))
    : null;
  const entitiesLower = filters.entities && filters.entities.length > 0
    ? filters.entities.map((e) => e.toLowerCase())
    : null;

  return chunks.filter((c) => {
    if (ctSet) {
      const ct = c.context.contentType?.toLowerCase();
      if (!ct || !ctSet.has(ct)) return false;
    }
    if (entitiesLower) {
      const ents = (c.context.entities ?? []).map((e) => e.toLowerCase());
      if (!entitiesLower.some((needle) => ents.includes(needle))) return false;
    }
    return true;
  });
}

/**
 * Diversify ranked chunks by chosen key, keeping at most `maxPerKey` per
 * unique key value. Preserves score order.
 */
export function diversifyChunks(
  chunks: RankedChunk[],
  by: DiversifyKey,
  maxPerKey: number,
): RankedChunk[] {
  const counts = new Map<string, number>();
  const out: RankedChunk[] = [];
  for (const c of chunks) {
    const key = diversifyKeyValue(c, by);
    if (key === null) {
      out.push(c);
      continue;
    }
    const n = counts.get(key) ?? 0;
    if (n < maxPerKey) {
      out.push(c);
      counts.set(key, n + 1);
    }
  }
  return out;
}

function diversifyKeyValue(chunk: RankedChunk, by: DiversifyKey): string | null {
  switch (by) {
    case 'document': return chunk.documentId;
    case 'keyConcept': return chunk.context.keyConcept ?? null;
    case 'contentType': return chunk.context.contentType ?? null;
  }
}

/** Top-K aggregation: how many chunks per contentType + top entities mentioned. */
export function computeFacets(chunks: RankedChunk[], topEntities = 10): {
  contentType: Record<string, number>;
  topEntities: string[];
} {
  const ct: Record<string, number> = {};
  const entityCount = new Map<string, number>();
  for (const c of chunks) {
    if (c.context.contentType && VALID_CONTENT_TYPES.has(c.context.contentType)) {
      ct[c.context.contentType] = (ct[c.context.contentType] ?? 0) + 1;
    }
    for (const e of c.context.entities ?? []) {
      entityCount.set(e, (entityCount.get(e) ?? 0) + 1);
    }
  }
  const top = [...entityCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topEntities)
    .map(([e]) => e);
  return { contentType: ct, topEntities: top };
}

/** Format a single search result per detail level.
 *  Three levels:
 *    minimal  — id + title + score + chunkContent + chunkSummary
 *    standard — adds authors (names), publishedAt, primary category, license,
 *               full chunkContext (summary + keyConcept + contentType + sectionPath + position)
 *    full     — adds licenses map, vector/bm25 scores, entities, selfContained,
 *               canServeFile, externalIds, totalChunks
 */
export function formatSearchResult(
  chunk: RankedChunk,
  doc: Document,
  detail: DetailLevel,
): Record<string, unknown> {
  if (detail === 'minimal') {
    return {
      documentId: chunk.documentId,
      title: doc.title,
      score: chunk.finalScore,
      chunkContent: truncateChunk(chunk.content).slice(0, 300),
      chunkSummary: chunk.context.summary ?? null,
    };
  }

  // standard + full share the base
  const result: Record<string, unknown> = {
    documentId: chunk.documentId,
    title: doc.title,
    authors: doc.authors.map((a) => a.name),
    publishedAt: doc.publishedAt instanceof Date
      ? doc.publishedAt.toISOString()
      : doc.publishedAt,
    category: doc.categories[0] ?? null,
    license: doc.license ?? null,
    score: chunk.finalScore,
    chunkContent: truncateChunk(chunk.content),
    chunkContext: {
      summary: chunk.context.summary ?? null,
      keyConcept: chunk.context.keyConcept ?? null,
      contentType: chunk.context.contentType ?? null,
      sectionPath: chunk.context.sectionPath ?? null,
      position: chunk.context.positionInDocument ?? 0,
    },
  };

  if (detail === 'full') {
    result.licenses = doc.licenses ?? {};
    result.indexingTier = doc.indexingTier ?? 'full';
    result.canServeFile = computeCanServeFile(doc);
    result.externalIds = doc.externalIds ?? {};
    result.categories = doc.categories;
    result.authorsFull = doc.authors;
    result.vectorScore = chunk.vectorScore;
    result.bm25Score = chunk.bm25Score;
    (result.chunkContext as Record<string, unknown>).entities =
      chunk.context.entities ?? null;
    (result.chunkContext as Record<string, unknown>).selfContained =
      chunk.context.selfContained ?? null;
    (result.chunkContext as Record<string, unknown>).totalChunks =
      chunk.context.totalChunks ?? 0;
  }

  return result;
}

/** Pagination cache shape — what's stored under search-pool:{searchId} */
export interface CachedSearchPool {
  pool: RankedChunk[];
  detail: DetailLevel;
  diversifyBy: DiversifyKey;
  maxPerKey: number;
  /** ISO timestamp when expires. Used to surface expiresAt back to agent. */
  expiresAt: string;
}

/**
 * Cache a search candidate pool for later pagination. Returns the searchId
 * (UUID) the agent must pass to `paginate`. If Redis is unavailable, returns
 * null — caller should omit searchId from response (paginate then errors
 * gracefully on missing pool).
 */
export async function cacheSearchPool(
  pool: RankedChunk[],
  detail: DetailLevel,
  diversifyBy: DiversifyKey,
  maxPerKey: number,
): Promise<{ searchId: string; expiresAt: string } | null> {
  const redis = getRedis();
  if (!redis) return null;
  const searchId = randomUUID();
  const expiresAt = new Date(Date.now() + SEARCH_POOL_TTL_SEC * 1000).toISOString();
  const cached: CachedSearchPool = { pool, detail, diversifyBy, maxPerKey, expiresAt };
  try {
    await redis.set(
      SEARCH_POOL_KEY_PREFIX + searchId,
      JSON.stringify(cached),
      'EX',
      SEARCH_POOL_TTL_SEC,
    );
    return { searchId, expiresAt };
  } catch {
    return null;
  }
}

/** Retrieve cached pool. Returns null if missing/expired/Redis unavailable. */
export async function loadCachedSearchPool(searchId: string): Promise<CachedSearchPool | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(SEARCH_POOL_KEY_PREFIX + searchId);
    if (!raw) return null;
    return JSON.parse(raw) as CachedSearchPool;
  } catch {
    return null;
  }
}
