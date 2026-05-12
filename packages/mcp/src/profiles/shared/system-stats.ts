/**
 * get_system_stats — live platform statistics.
 *
 * Free tool (0 credits). Aggregates Core DB + Qdrant + Gov + Portal.
 * On Gov/Portal failure, that section returns zeros (logged warn).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../context.js';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? '';
const GOV_URL = process.env.GOV_INTERNAL_URL ?? 'http://localhost:3300';
const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://localhost:3200';
const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';
const STATS_TIMEOUT_MS = 3000;

interface GovStats {
  total_agents: number;
  total_initiatives: number;
  active_initiatives: number;
  total_votes_cast: number;
}

interface UserStats {
  total_registered: number;
  total_api_tokens: number;
  total_mcp_requests_30d: number;
}

const GOV_STATS_ZERO: GovStats = {
  total_agents: 0, total_initiatives: 0, active_initiatives: 0, total_votes_cast: 0,
};
const USER_STATS_ZERO: UserStats = {
  total_registered: 0, total_api_tokens: 0, total_mcp_requests_30d: 0,
};

async function fetchGovStats(): Promise<GovStats> {
  try {
    const resp = await fetch(`${GOV_URL}/api/internal/gov-stats`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[system-stats] gov-stats HTTP ${resp.status}, using zeros`);
      return GOV_STATS_ZERO;
    }
    const data = await resp.json() as Partial<GovStats>;
    return {
      total_agents: Number(data.total_agents ?? 0),
      total_initiatives: Number(data.total_initiatives ?? 0),
      active_initiatives: Number(data.active_initiatives ?? 0),
      total_votes_cast: Number(data.total_votes_cast ?? 0),
    };
  } catch (err) {
    console.warn(`[system-stats] gov-stats fetch failed: ${err instanceof Error ? err.message : err}`);
    return GOV_STATS_ZERO;
  }
}

async function fetchUserStats(): Promise<UserStats> {
  try {
    const resp = await fetch(`${PORTAL_URL}/api/internal/user-stats`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[system-stats] user-stats HTTP ${resp.status}, using zeros`);
      return USER_STATS_ZERO;
    }
    const data = await resp.json() as Partial<UserStats>;
    return {
      total_registered: Number(data.total_registered ?? 0),
      total_api_tokens: Number(data.total_api_tokens ?? 0),
      total_mcp_requests_30d: Number(data.total_mcp_requests_30d ?? 0),
    };
  } catch (err) {
    console.warn(`[system-stats] user-stats fetch failed: ${err instanceof Error ? err.message : err}`);
    return USER_STATS_ZERO;
  }
}

// Cache: stats don't change often, queries are heavy
let cachedStats: unknown = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

async function fetchStats(ctx: AppContext): Promise<unknown> {
  if (cachedStats && Date.now() < cacheExpiresAt) return cachedStats;

  const [docStats, chunkStats, coverageStats, pipelineStats, avgCost, qdrantPoints, govStats, userStats] = await Promise.all([
    // documents_indexed, documents_ready, by indexing tier.
    // Soft-deleted docs must NOT count (contracts/document_soft_delete.md §2)
    // — public counters reflect reachable-to-search documents only.
    ctx.pool.query<{ total: string; ready: string; full_indexed: string; abstract_only: string }>(
      `SELECT count(*)::text as total,
              count(*) FILTER (WHERE status = 'ready')::text as ready,
              count(*) FILTER (WHERE status = 'ready' AND indexing_tier = 'full')::text as full_indexed,
              count(*) FILTER (WHERE status = 'ready' AND (indexing_tier = 'abstract_only' OR indexing_tier IS NULL))::text as abstract_only
         FROM documents WHERE deleted_at IS NULL`,
    ),
    // chunks breakdown by lifecycle status (openarx-q2eh)
    ctx.pool.query<{
      total: string; indexed: string; indexed_partial: string;
      embedded: string; pending_embed: string;
    }>(
      `SELECT
         count(*)::text as total,
         count(*) FILTER (WHERE status = 'indexed')::text as indexed,
         count(*) FILTER (WHERE status = 'indexed_partial')::text as indexed_partial,
         count(*) FILTER (WHERE status = 'embedded')::text as embedded,
         count(*) FILTER (WHERE status = 'pending_embed')::text as pending_embed
         FROM chunks`,
    ),
    // coverage date range
    ctx.pool.query<{ min_date: string | null; max_date: string | null }>(
      `SELECT min(date)::text as min_date, max(date)::text as max_date FROM coverage_map WHERE source = 'arxiv'`,
    ),
    // pipeline runs
    ctx.pool.query<{ total: string; last_status: string | null; last_date: Date | null }>(
      `SELECT count(*)::text as total,
              (SELECT status FROM pipeline_runs ORDER BY started_at DESC LIMIT 1) as last_status,
              (SELECT started_at FROM pipeline_runs ORDER BY started_at DESC LIMIT 1) as last_date
       FROM pipeline_runs`,
    ),
    // avg cost per document (rounded to cents per contract §Profile: v1).
    // Exclude NaN rows — one poisoned row makes pg avg() return NaN.
    ctx.pool.query<{ avg_cost: string | null }>(
      `SELECT round(avg(processing_cost)::numeric, 2)::text as avg_cost
         FROM documents
        WHERE processing_cost IS NOT NULL
          AND processing_cost <> 'NaN'::numeric`,
    ),
    // qdrant points count (via REST, no SDK dependency)
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (QDRANT_API_KEY) headers['api-key'] = QDRANT_API_KEY;
        const resp = await fetch(`${QDRANT_URL}/collections/chunks`, { headers, signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return 0;
        const data = await resp.json() as { result?: { points_count?: number } };
        return data.result?.points_count ?? 0;
      } catch {
        return 0;
      }
    })(),
    // Gov aggregate (fails silently → zeros)
    fetchGovStats(),
    // Portal user aggregate (fails silently → zeros)
    fetchUserStats(),
  ]);

  const coverage = coverageStats.rows[0];
  const pipeline = pipelineStats.rows[0];

  const stats = {
    platform: {
      documents_indexed: parseInt(docStats.rows[0]?.total ?? '0', 10),
      documents_ready: parseInt(docStats.rows[0]?.ready ?? '0', 10),
      documents_full_indexed: parseInt(docStats.rows[0]?.full_indexed ?? '0', 10),
      documents_abstract_only: parseInt(docStats.rows[0]?.abstract_only ?? '0', 10),
      chunks_total: parseInt(chunkStats.rows[0]?.total ?? '0', 10),
      chunks_indexed: parseInt(chunkStats.rows[0]?.indexed ?? '0', 10),
      chunks_indexed_partial: parseInt(chunkStats.rows[0]?.indexed_partial ?? '0', 10),
      chunks_embedded: parseInt(chunkStats.rows[0]?.embedded ?? '0', 10),
      chunks_pending_embed: parseInt(chunkStats.rows[0]?.pending_embed ?? '0', 10),
      qdrant_points: qdrantPoints,
      coverage_date_range: coverage?.min_date && coverage?.max_date
        ? `${coverage.min_date} — ${coverage.max_date}`
        : null,
      categories: ['cs.AI', 'cs.CL', 'cs.LG'],
    },
    pipeline: {
      total_pipeline_runs: parseInt(pipeline?.total ?? '0', 10),
      last_run_status: pipeline?.last_status ?? null,
      last_run_date: pipeline?.last_date ? new Date(pipeline.last_date).toISOString() : null,
      avg_cost_per_document: parseFloat(avgCost.rows[0]?.avg_cost ?? '0') || 0,
    },
    users: userStats,
    governance: govStats,
  };

  cachedStats = stats;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return stats;
}

export function registerSystemStats(server: McpServer, ctx: AppContext): void {
  server.tool(
    'get_system_stats',
    'Get live OpenArx platform statistics: documents indexed, pipeline status, coverage range, user counts, governance activity. Free (0 credits).',
    {},
    async () => {
      const stats = await fetchStats(ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] };
    },
  );
}
