/**
 * Gov Identity — resolve Portal user_id → Gov agentId.
 *
 * On first gov tool call, looks up agentId via Gov API.
 * If not registered, auto-registers the agent in Gov.
 * Caches mapping in memory (survives for process lifetime).
 */

const GOV_URL = process.env.GOV_INTERNAL_URL ?? 'http://localhost:3300';
const INTERNAL_SECRET = process.env.CORE_INTERNAL_SECRET ?? '';

const agentIdCache = new Map<string, string>();

/**
 * Resolve a Portal user_id to a Gov agentId.
 * Auto-registers if not found. Returns null on error (non-blocking).
 */
export async function resolveAgentId(
  portalUserId: string,
  userName?: string,
): Promise<string | null> {
  // Cache hit
  const cached = agentIdCache.get(portalUserId);
  if (cached) return cached;

  try {
    // Lookup by portal user ID
    const lookupResp = await fetch(`${GOV_URL}/agents/by-portal-user/${portalUserId}`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(5000),
    });

    if (lookupResp.ok) {
      const data = await lookupResp.json() as { agentId: string };
      agentIdCache.set(portalUserId, data.agentId);
      return data.agentId;
    }

    if (lookupResp.status === 404) {
      // Not registered — auto-register.
      // Omit `name` by default: Gov generates a docker-style name (openarx-gov-6o9).
      // If caller supplied userName (e.g. Portal preferred_display_name), pass it
      // through — Gov's caller-supplied-wins precedence preserves the override.
      const body: Record<string, unknown> = { portal_user_id: portalUserId };
      if (userName) body.name = userName;
      const registerResp = await fetch(`${GOV_URL}/agents/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (registerResp.ok) {
        const data = await registerResp.json() as { agentId: string };
        agentIdCache.set(portalUserId, data.agentId);
        console.error(`[gov-identity] Auto-registered agent for user ${portalUserId} → ${data.agentId}`);
        return data.agentId;
      }

      // 409 = already registered (race condition) — retry lookup.
      // Gov no longer includes agentId in 409 body (privacy hardening, Gov report R2).
      if (registerResp.status === 409) {
        const retryResp = await fetch(`${GOV_URL}/agents/by-portal-user/${portalUserId}`, {
          headers: { 'X-Internal-Secret': INTERNAL_SECRET },
          signal: AbortSignal.timeout(5000),
        });
        if (retryResp.ok) {
          const data = await retryResp.json() as { agentId: string };
          agentIdCache.set(portalUserId, data.agentId);
          return data.agentId;
        }
        console.error(`[gov-identity] 409 from register but subsequent lookup also failed for ${portalUserId}: ${retryResp.status}`);
        return null;
      }

      // 403 = portal user banned (Gov report R3) — agent cannot register.
      // Surface as distinct error so operator knows the cause.
      if (registerResp.status === 403) {
        console.error(`[gov-identity] Registration forbidden (banned portal user) for ${portalUserId}`);
        return null;
      }

      // 429 = daily registration cap hit (Gov report R4).
      // Log with retry-after hint if provided. Caller should not hot-retry.
      if (registerResp.status === 429) {
        const retryAfter = registerResp.headers.get('retry-after') ?? 'unknown';
        console.error(`[gov-identity] Registration rate limited for ${portalUserId} (retry-after: ${retryAfter}s)`);
        return null;
      }

      console.error(`[gov-identity] Register failed for ${portalUserId}: ${registerResp.status}`);
      return null;
    }

    console.error(`[gov-identity] Lookup failed for ${portalUserId}: ${lookupResp.status}`);
    return null;
  } catch (err) {
    console.error(`[gov-identity] Error resolving agentId for ${portalUserId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Clear cached agentId (e.g. after agent deletion). */
export function clearAgentCache(portalUserId?: string): void {
  if (portalUserId) {
    agentIdCache.delete(portalUserId);
  } else {
    agentIdCache.clear();
  }
}

// ── Agent reputation cache (TTL 5 min) ──────────────────────

const REPUTATION_TTL_MS = 5 * 60 * 1000;
const reputationCache = new Map<string, { reputation: number; expiresAt: number }>();

/**
 * Get agent reputation from Gov (cached, TTL 5 min).
 * Used for discount calculation in Portal tool-check.
 * Returns null if Gov unavailable — toolCheck works without discount.
 */
export async function getAgentReputation(agentId: string): Promise<number | null> {
  const cached = reputationCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) return cached.reputation;

  try {
    const resp = await fetch(`${GOV_URL}/agents/${agentId}/reputation`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) {
      console.error(`[gov-identity] Reputation fetch failed for ${agentId}: ${resp.status}`);
      return cached?.reputation ?? null; // stale cache better than nothing
    }

    const data = await resp.json() as { reputation: number };
    reputationCache.set(agentId, { reputation: data.reputation, expiresAt: Date.now() + REPUTATION_TTL_MS });
    return data.reputation;
  } catch (err) {
    console.error(`[gov-identity] Reputation error for ${agentId}: ${err instanceof Error ? err.message : err}`);
    return cached?.reputation ?? null;
  }
}

// ── Agent tier cache (TTL 5 min) ────────────────────────────

const TIER_TTL_MS = 5 * 60 * 1000;
const tierCache = new Map<string, { tier: string; expiresAt: number }>();

/**
 * Get agent tier from Gov (cached, TTL 5 min).
 * Used for tier-gated MCP tool authorization.
 * Returns null if Gov unavailable / agent missing — caller treats as unverified.
 */
export async function getAgentTier(agentId: string): Promise<string | null> {
  const cached = tierCache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  try {
    const resp = await fetch(`${GOV_URL}/agents/${agentId}`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) {
      console.error(`[gov-identity] Tier fetch failed for ${agentId}: ${resp.status}`);
      return cached?.tier ?? null;
    }

    const data = await resp.json() as { tier?: string };
    const tier = data.tier;
    if (typeof tier !== 'string') return cached?.tier ?? null;
    tierCache.set(agentId, { tier, expiresAt: Date.now() + TIER_TTL_MS });
    return tier;
  } catch (err) {
    console.error(`[gov-identity] Tier error for ${agentId}: ${err instanceof Error ? err.message : err}`);
    return cached?.tier ?? null;
  }
}
