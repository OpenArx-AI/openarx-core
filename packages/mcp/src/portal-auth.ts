/**
 * Portal token validation + credit deduction client.
 *
 * Validates user Bearer tokens by SHA-256 hashing and checking against
 * Portal's internal API. Caches validation results for 60s.
 */

import { createHash } from 'node:crypto';

const PORTAL_URL = process.env.PORTAL_INTERNAL_URL ?? 'http://localhost:3200';
const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';
const CACHE_TTL_MS = 60_000; // 60 seconds

export interface TokenInfo {
  valid: boolean;
  // Portal API returns snake_case; we normalize to camelCase after fetch
  userId?: string;
  tokenId?: string;
  tokenType?: string;
  permissions?: {
    search: boolean;
    get_document: boolean;
    find_related: boolean;
    find_code: boolean;
    enrich: boolean;
  };
  creditsBalance?: number;
  reason?: string;
}

interface CacheEntry {
  info: TokenInfo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isPortalAuthEnabled(): boolean {
  return INTERNAL_SECRET.length > 0;
}

/**
 * Validate a Bearer token against Portal's internal API.
 * Returns cached result if available and fresh.
 */
export async function verifyToken(bearerToken: string): Promise<TokenInfo> {
  const tokenHash = hashToken(bearerToken);

  // Check cache
  const cached = cache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.info;
  }

  try {
    const resp = await fetch(`${PORTAL_URL}/api/internal/verify-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ token_hash: tokenHash }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      return { valid: false, reason: `portal_error_${resp.status}` };
    }

    const raw = (await resp.json()) as Record<string, unknown>;

    // Normalize snake_case from Portal API to camelCase
    const info: TokenInfo = {
      valid: raw.valid as boolean,
      userId: raw.user_id as string | undefined,
      tokenId: raw.token_id as string | undefined,
      tokenType: raw.token_type as string | undefined,
      permissions: raw.permissions as TokenInfo['permissions'],
      creditsBalance: raw.credits_balance as number | undefined,
      reason: raw.reason as string | undefined,
    };

    // Cache result
    cache.set(tokenHash, { info, expiresAt: Date.now() + CACHE_TTL_MS });

    // Evict old entries periodically
    if (cache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (v.expiresAt < now) cache.delete(k);
      }
    }

    return info;
  } catch (err) {
    // Portal unreachable — fail open or closed?
    // Fail closed: deny access if portal is down
    return { valid: false, reason: 'portal_unreachable' };
  }
}

/**
 * Deduct one credit from user's balance after a tool call.
 * Fire-and-forget: failures are logged but don't block the response.
 */
export async function deductCredit(
  userId: string,
  tokenId: string,
  toolName: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ creditsCharged: number } | null> {
  try {
    const resp = await fetch(`${PORTAL_URL}/api/internal/deduct-credit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ user_id: userId, token_id: tokenId, tool_name: toolName, ip_address: ipAddress, user_agent: userAgent }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[portal-auth] deduct-credit failed (${resp.status}): ${body}`);
      return null;
    }

    const data = await resp.json() as Record<string, unknown>;
    return { creditsCharged: (data.credits_charged as number) ?? 1 };
  } catch (err) {
    console.error('[portal-auth] deduct-credit error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Unified billing (v2): tool-check + tool-deduct ──────────

export interface ToolCheckResult {
  allowed: boolean;
  effectiveCost: number;
  baseCost?: number;
  reputationDiscount?: number;
  holderDiscount?: number;
  creditsBalance?: number;
  reason?: string;
}

/**
 * Pre-check: can user afford this tool call?
 * Returns effective_cost after discounts. Returns null on error (fallback to legacy).
 */
export async function toolCheck(
  userId: string,
  costKey: string,
  agentReputation?: number,
): Promise<ToolCheckResult | null> {
  try {
    const body: Record<string, unknown> = { user_id: userId, cost_key: costKey };
    if (agentReputation !== undefined) body.agent_reputation = agentReputation;

    const resp = await fetch(`${PORTAL_URL}/api/internal/tool-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      console.error(`[portal-auth] tool-check failed (${resp.status})`);
      return null;
    }

    const data = await resp.json() as Record<string, unknown>;
    return {
      allowed: data.allowed as boolean,
      effectiveCost: (data.effective_cost as number) ?? 1,
      baseCost: data.base_cost as number | undefined,
      reputationDiscount: data.reputation_discount as number | undefined,
      holderDiscount: data.holder_discount as number | undefined,
      creditsBalance: data.credits_balance as number | undefined,
      reason: data.reason as string | undefined,
    };
  } catch (err) {
    console.error('[portal-auth] tool-check error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Post-deduct: charge user for completed tool call.
 * Returns balance_after. Returns null on error.
 */
export async function toolDeduct(
  userId: string,
  tokenId: string,
  costKey: string,
  effectiveCost: number,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ balanceAfter: number; creditsCharged: number } | null> {
  try {
    const resp = await fetch(`${PORTAL_URL}/api/internal/tool-deduct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({
        user_id: userId,
        token_id: tokenId,
        cost_key: costKey,
        effective_cost: effectiveCost,
        ip_address: ipAddress,
        user_agent: userAgent,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      console.error(`[portal-auth] tool-deduct failed (${resp.status})`);
      return null;
    }

    const data = await resp.json() as Record<string, unknown>;
    return {
      balanceAfter: (data.balance_after as number) ?? 0,
      creditsCharged: effectiveCost,
    };
  } catch (err) {
    console.error('[portal-auth] tool-deduct error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Tier hierarchy + per-tool minimum tiers (BUG-mutes-001) ───

export const TIER_ORDER: Record<string, number> = {
  unverified: 0,
  basic: 1,
  standard: 2,
  trusted: 3,
  authority: 4,
};

export type Tier = keyof typeof TIER_ORDER;

/**
 * Minimum tier required per gov-profile tool. Token-permission tools
 * (search, get_document, ...) are authorized via info.permissions instead.
 *
 * Tools NOT in this map + NOT in TOKEN_PERMISSION_TOOLS fall through to
 * tool_not_permitted (config bug) rather than silent deny.
 */
export const TOOL_MIN_TIER: Record<string, Tier> = {
  // reads + meta — all tiers including unverified
  list_categories: 'unverified',
  list_initiatives: 'unverified',
  get_initiative: 'unverified',
  get_my_profile: 'unverified',
  get_agent_profile: 'unverified',
  get_leaderboard: 'unverified',
  list_news: 'unverified',
  get_news_item: 'unverified',
  gov_search: 'unverified',
  // tier-promotion path — unverified agents MUST reach these
  challenge_status: 'unverified',
  request_challenge: 'unverified',
  solve_challenge: 'unverified',
  // writes, basic
  mute_agent: 'basic',
  react: 'basic',
  post_message: 'basic',
  // writes, standard
  cast_vote: 'standard',
  create_initiative: 'standard',
  advance_to_voting: 'standard',
  withdraw_initiative: 'standard',
  publish_initiative: 'standard',
};

export type PermissionResult =
  | { allow: true }
  | { allow: false; errorBody: Record<string, unknown> };

/**
 * Token-level permission check (non-gov tools + always-free tools).
 *
 * Gov-profile tier-gated tools return `allow: true` here — their tier
 * check happens after agentId resolution in index.ts via `checkTier()`.
 */
export function hasPermission(info: TokenInfo, toolName: string): PermissionResult {
  const p = info.permissions;

  // Token-permission tools (search / docs). Search v2 tools share
  // perms.search — they're specialised search workflows, not a new
  // permission category. get_chunks mirrors get_document since both
  // are document-level reads. paginate continues a search session.
  const tokenGated: Record<string, (perms: NonNullable<TokenInfo['permissions']>) => boolean> = {
    // Pre-existing v1 tools
    search: (perms) => perms.search ?? false,
    get_document: (perms) => perms.get_document ?? false,
    find_related: (perms) => perms.find_related ?? false,
    find_code: (perms) => perms.find_code ?? false,
    find_by_id: (perms) => perms.get_document ?? false,
    // Search v2 (gated by perms.search)
    search_keyword: (perms) => perms.search ?? false,
    search_semantic: (perms) => perms.search ?? false,
    find_methodology: (perms) => perms.search ?? false,
    find_benchmark_results: (perms) => perms.search ?? false,
    find_evidence: (perms) => perms.search ?? false,
    compare_papers: (perms) => perms.search ?? false,
    explore_topic: (perms) => perms.search ?? false,
    paginate: (perms) => perms.search ?? false,
    // Document-level chunk read (mirrors get_document)
    get_chunks: (perms) => perms.get_document ?? false,
  };
  if (toolName in tokenGated) {
    if (!p) {
      return {
        allow: false,
        errorBody: { error: 'Permission denied', tool: toolName, reason: 'no_permissions_on_token' },
      };
    }
    return tokenGated[toolName](p)
      ? { allow: true }
      : {
          allow: false,
          errorBody: { error: 'Permission denied', tool: toolName, reason: 'permission_flag_false' },
        };
  }

  // Always-free tools (meta / stats / user-scoped reads)
  const alwaysAllowed = new Set(['get_system_stats', 'get_document_status', 'get_my_documents']);
  if (alwaysAllowed.has(toolName)) return { allow: true };

  // Gov-profile tools: permission at token level is OK; tier check is deferred.
  if (toolName in TOOL_MIN_TIER) return { allow: true };

  // Unknown tool — config bug, not user fault. Diagnostic reason makes
  // future cases debuggable from QA-side without reading Core source.
  console.warn(`[hasPermission] unknown tool (not in any map): ${toolName}`);
  return {
    allow: false,
    errorBody: { error: 'tool_not_permitted', tool: toolName, reason: 'tool_not_in_permission_map' },
  };
}

/**
 * Tier-based check for gov-profile tools. Called after agentId is resolved
 * and tier is fetched from Gov. No-op for tools not in TOOL_MIN_TIER.
 */
export function checkTier(tier: string | null, toolName: string): PermissionResult {
  const minTier = TOOL_MIN_TIER[toolName];
  if (!minTier) return { allow: true }; // not a tier-gated tool
  const effectiveTier = tier ?? 'unverified';
  const currentRank = TIER_ORDER[effectiveTier] ?? -1;
  const minRank = TIER_ORDER[minTier];
  if (currentRank < minRank) {
    return {
      allow: false,
      errorBody: {
        error: 'tier_insufficient',
        tool: toolName,
        required: minTier,
        current: effectiveTier,
      },
    };
  }
  return { allow: true };
}
