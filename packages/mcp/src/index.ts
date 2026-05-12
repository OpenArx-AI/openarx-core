#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext } from './context.js';
import { getProfile, getAllProfiles } from './profiles/registry.js';
import { isTokenTypeSufficient } from './profiles/types.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { registerInternalRoutes } from './internal-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import { isPortalAuthEnabled, verifyToken, deductCredit, hasPermission, checkTier, toolCheck, toolDeduct, type TokenInfo } from './portal-auth.js';
import { logRequest, extractResultSummary } from './request-logger.js';
import { getCostKey } from './cost-key.js';
import { resolveAgentId, getAgentReputation, getAgentTier } from './gov-identity.js';
import { UsageTracker, withUsageTracker } from './lib/usage-tracker.js';
import { incrementCallCounters } from './lib/cost-counters.js';
import { startRollupTimer } from './lib/cost-rollup.js';

const HOST = process.env.MCP_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.MCP_PORT ?? '3100', 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';

const log = (...args: unknown[]): void => {
  console.error('[openarx-mcp]', ...args);
};

// ── Metrics ──────────────────────────────────────────────────────────

interface ToolMetrics {
  invocations: number;
  errors: number;
  durationsMs: number[];
}

const metrics = new Map<string, ToolMetrics>();
let requestCount = 0;

function recordInvocation(profile: string, tool: string, durationMs: number, isError: boolean): void {
  const key = `${profile}/${tool}`;
  let m = metrics.get(key);
  if (!m) { m = { invocations: 0, errors: 0, durationsMs: [] }; metrics.set(key, m); }
  m.invocations++;
  if (isError) m.errors++;
  m.durationsMs.push(durationMs);
  // Keep last 1000 measurements per tool
  if (m.durationsMs.length > 1000) m.durationsMs = m.durationsMs.slice(-500);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMetrics(): string {
  const lines: string[] = [
    '# HELP mcp_tool_invocation_total Total tool invocations',
    '# TYPE mcp_tool_invocation_total counter',
    '# HELP mcp_tool_errors_total Total tool errors',
    '# TYPE mcp_tool_errors_total counter',
    '# HELP mcp_tool_duration_ms Tool invocation duration in milliseconds',
    '# TYPE mcp_tool_duration_ms summary',
    '# HELP mcp_requests_total Total HTTP requests to MCP endpoints',
    '# TYPE mcp_requests_total counter',
    `mcp_requests_total ${requestCount}`,
  ];

  for (const [key, m] of metrics) {
    const [profile, tool] = key.split('/');
    const labels = `profile="${profile}",tool="${tool}"`;
    lines.push(`mcp_tool_invocation_total{${labels}} ${m.invocations}`);
    lines.push(`mcp_tool_errors_total{${labels}} ${m.errors}`);
    if (m.durationsMs.length > 0) {
      const sorted = [...m.durationsMs].sort((a, b) => a - b);
      lines.push(`mcp_tool_duration_ms{${labels},quantile="0.5"} ${percentile(sorted, 50)}`);
      lines.push(`mcp_tool_duration_ms{${labels},quantile="0.95"} ${percentile(sorted, 95)}`);
      lines.push(`mcp_tool_duration_ms{${labels},quantile="0.99"} ${percentile(sorted, 99)}`);
      lines.push(`mcp_tool_duration_ms_count{${labels}} ${m.durationsMs.length}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting server...');

  const ctx = createContext();
  const app = express();

  // ── Public endpoints (no auth) ─────────────────────────────────

  app.get('/health', async (_req: Request, res: Response) => {
    const { getRedisStatus } = await import('./lib/redis.js');
    const redis = await getRedisStatus();
    res.json({ status: 'ok', profiles: getAllProfiles().map((p) => p.id), redis });
  });

  app.get('/versions', (_req: Request, res: Response) => {
    const profiles = getAllProfiles().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      url: `/${p.id}/mcp`,
      min_token_type: p.minTokenType,
    }));
    res.json({ profiles });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(formatMetrics());
  });

  // ── OAuth2 discovery (RFC 8414 + RFC 9728) ────────────────────

  const PORTAL_ISSUER = process.env.PORTAL_OAUTH_ISSUER ?? 'https://portal.openarx.ai';
  const MCP_RESOURCE = process.env.MCP_PUBLIC_URL ?? 'https://mcp.openarx.ai';

  // Authorization Server Metadata — tells clients where to authenticate
  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: PORTAL_ISSUER,
      authorization_endpoint: `${PORTAL_ISSUER}/oauth/authorize`,
      token_endpoint: `${PORTAL_ISSUER}/oauth/token`,
      registration_endpoint: `${PORTAL_ISSUER}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:read'],
    });
  });

  // OAuth proxy: Claude.ai sends OAuth requests to MCP domain instead of Portal.
  // Redirect doesn't work for POST /oauth/token (clients drop body on redirect).
  // Proxy the request to Portal instead.
  app.use('/oauth', express.urlencoded({ extended: true }), express.json(), async (req: Request, res: Response) => {
    const targetUrl = `${PORTAL_ISSUER}/oauth${req.url}`;

    // GET requests (authorize page) — redirect to Portal
    if (req.method === 'GET') {
      res.redirect(307, targetUrl);
      return;
    }

    // POST requests (token, register, consent) — proxy to Portal
    try {
      const isForm = req.headers['content-type']?.includes('form-urlencoded');
      const proxyResp = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'application/json',
        },
        body: isForm
          ? new URLSearchParams(req.body as Record<string, string>).toString()
          : JSON.stringify(req.body),
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });

      // Forward status + headers + body
      res.status(proxyResp.status);
      const contentType = proxyResp.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      // Validate Location header domain to prevent open redirect
      const location = proxyResp.headers.get('location');
      if (location) {
        try {
          const portalOrigin = new URL(PORTAL_ISSUER).origin;
          const locationOrigin = new URL(location, PORTAL_ISSUER).origin;
          if (locationOrigin === portalOrigin) {
            res.setHeader('Location', location);
          }
        } catch {
          // Invalid URL — don't forward
        }
      }
      const body = await proxyResp.text();
      res.send(body);
    } catch (err) {
      console.error(`[oauth-proxy] Error proxying ${req.method} ${req.url}: ${err instanceof Error ? err.message : err}`);
      res.status(502).json({ error: 'oauth_proxy_error' });
    }
  });

  // Protected Resource Metadata — tells clients this resource requires OAuth2
  // Also handles path-specific variant (Inspector appends MCP path: /.well-known/oauth-protected-resource/v1/mcp)
  app.use('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: MCP_RESOURCE,
      authorization_servers: [PORTAL_ISSUER],
      scopes_supported: ['mcp:read'],
      bearer_methods_supported: ['header'],
    });
  });

  // ── CORS for browser-based clients (MCP Inspector, web UIs) ────

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Bearer, X-Custom-Auth-Headers, Mcp-Session-Id, Mcp-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Rate limiting (configurable via env, requests per minute) ──
  //
  // Uses Redis store when available (shared across cluster workers).
  // Falls back to in-memory if Redis is unavailable.

  const RATE_LIMIT_PUBLIC = parseInt(process.env.RATE_LIMIT_PUBLIC ?? '120', 10);
  const RATE_LIMIT_MCP = parseInt(process.env.RATE_LIMIT_MCP ?? '60', 10);
  const RATE_LIMIT_MCP_PER_USER = parseInt(process.env.RATE_LIMIT_MCP_PER_USER ?? '120', 10);
  const RATE_LIMIT_OAUTH = parseInt(process.env.RATE_LIMIT_OAUTH ?? '30', 10);
  const RATE_LIMIT_INTERNAL = parseInt(process.env.RATE_LIMIT_INTERNAL ?? '120', 10);

  // Redis store factory for cross-worker rate limiting (unique prefix per limiter)
  const { getRedis } = await import('./lib/redis.js');
  const redis = getRedis();
  let RedisStoreClass: (typeof import('rate-limit-redis'))['RedisStore'] | null = null;
  if (redis) {
    const mod = await import('rate-limit-redis');
    RedisStoreClass = mod.RedisStore;
    log('Rate limiting: Redis store');
  } else {
    log('Rate limiting: in-memory (Redis unavailable)');
  }

  const createLimiter = (max: number, name: string, keyGenerator?: (req: Request) => string) => rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: RedisStoreClass && redis
      ? new RedisStoreClass({ prefix: `rl:${name}:`, sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as never })
      : undefined,
    keyGenerator,
    message: { error: 'rate_limited', message: `Too many requests (limit: ${max}/min)` },
    handler: (_req, res) => {
      log(`Rate limit hit: ${name}`);
      res.status(429).json({ error: 'rate_limited', message: `Too many requests (limit: ${max}/min)` });
    },
  });

  app.use('/health', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/versions', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/metrics', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/.well-known', createLimiter(RATE_LIMIT_PUBLIC, 'well-known'));
  app.use('/oauth', createLimiter(RATE_LIMIT_OAUTH, 'oauth'));
  app.use('/api/internal', createLimiter(RATE_LIMIT_INTERNAL, 'internal'));

  // MCP endpoints — per-IP limiter
  const mcpLimiter = createLimiter(RATE_LIMIT_MCP, 'mcp');
  app.post('/:profile/mcp', mcpLimiter);

  // MCP per-user limiter — applied after auth extracts userId (higher limit than per-IP)
  const mcpUserLimiter = createLimiter(RATE_LIMIT_MCP_PER_USER, 'mcp-user', (req: Request) => {
    const token = (req as unknown as Record<string, unknown>)._portalToken as { userId?: string } | undefined;
    return token?.userId ?? 'anon';
  });
  app.post('/:profile/mcp', mcpUserLimiter);

  // ── Auth middleware ─────────────────────────────────────────────

  const portalAuth = isPortalAuthEnabled();
  if (portalAuth) {
    log('Portal auth enabled (CORE_INTERNAL_SECRET set)');
  }

  if (AUTH_TOKEN || portalAuth) {
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      // Skip auth for public endpoints, internal API (has own auth), admin
      // API (has own Bearer auth per admin-routes.ts), discovery, preflight.
      if (
        req.path === '/health'
        || req.path === '/versions'
        || req.path === '/metrics'
        || req.path.startsWith('/api/internal')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/.well-known')
        || req.path.startsWith('/oauth')
        || req.method === 'OPTIONS'
      ) {
        next();
        return;
      }

      // Extract token from Authorization or Bearer header
      const auth = req.headers.authorization;
      const bearerDirect = req.headers.bearer as string | undefined;
      const token = auth?.replace('Bearer ', '') ?? bearerDirect;

      const wwwAuth = `Bearer realm="${MCP_RESOURCE}", resource_metadata="${MCP_RESOURCE}/.well-known/oauth-protected-resource"`;

      if (!token) {
        res.setHeader('WWW-Authenticate', wwwAuth);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // 1. Check hardcoded dev token (fallback)
      if (AUTH_TOKEN && token === AUTH_TOKEN) {
        next();
        return;
      }

      // 2. Check via Portal internal API
      if (portalAuth) {
        const info = await verifyToken(token);
        if (!info.valid) {
          res.setHeader('WWW-Authenticate', `${wwwAuth}, error="invalid_token"`);
          res.status(401).json({ error: 'Unauthorized', reason: info.reason ?? 'invalid_token' });
          return;
        }
        if (info.creditsBalance !== undefined && info.creditsBalance <= 0) {
          res.status(402).json({ error: 'Insufficient credits', balance: 0 });
          return;
        }
        // Attach token info to request for downstream use (credit deduction)
        (req as unknown as Record<string, unknown>)._portalToken = info;
        next();
        return;
      }

      res.setHeader('WWW-Authenticate', wwwAuth);
      res.status(401).json({ error: 'Unauthorized' });
    });
    log('Auth enabled');
  } else {
    log('WARNING: No auth configured — server is open');
  }

  // ── Profile-routed MCP endpoint (Streamable HTTP, stateless) ──

  app.post('/:profile/mcp', express.json(), async (req: Request, res: Response) => {
    requestCount++;
    const profileId = String(req.params.profile);
    const profile = getProfile(profileId);

    if (!profile) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: `Unknown profile: ${profileId}. GET /versions for available profiles.` },
        id: null,
      });
      return;
    }

    // Check token type meets profile minimum
    const portalToken = (req as unknown as Record<string, unknown>)._portalToken as TokenInfo | undefined;
    if (portalToken && !isTokenTypeSufficient(portalToken.tokenType, profile.minTokenType)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: `Token type '${portalToken.tokenType ?? 'unknown'}' insufficient for profile '${profileId}' (requires '${profile.minTokenType}')` },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    const server = new McpServer({
      name: `openarx-${profile.id}`,
      version: profile.version,
    });

    // Wrap tool registration with metrics + portal credit deduction
    const originalTool = server.tool.bind(server);
    server.tool = function (name: string, ...rest: unknown[]) {
      const args = [name, ...rest];
      const handlerIdx = args.findIndex((a, i) => i > 0 && typeof a === 'function');
      if (handlerIdx > 0) {
        const originalHandler = args[handlerIdx] as (...a: unknown[]) => Promise<unknown>;
        args[handlerIdx] = async (...handlerArgs: unknown[]) => {
          // Token-level permission check (search perms + always-free tools).
          // Tier-gated gov tools return allow=true here — their tier check
          // happens after agentId resolution below.
          if (portalToken) {
            const perm = hasPermission(portalToken, name);
            if (!perm.allow) {
              return { content: [{ type: 'text', text: JSON.stringify(perm.errorBody) }] };
            }
          }

          const start = Date.now();
          let isError = false;
          let errorMsg: string | null = null;
          let creditsCharged: number | null = null;
          let toolResult: unknown = undefined;
          const ip = req.headers['x-forwarded-for'] as string ?? req.socket.remoteAddress ?? '';
          const userAgent = req.headers['user-agent'] as string ?? '';
          const toolArgs = (handlerArgs[0] ?? {}) as Record<string, unknown>;
          const costKey = getCostKey(name, toolArgs);

          // Per-request usage tracker for LLM/embed cost capture
          // (openarx-2a5f). Threaded via AsyncLocalStorage so all
          // descendant async calls in the handler can record without
          // explicit ctx threading.
          const usage = new UsageTracker();

          try {
            // For gov profile: resolve agentId server-side (never trust client-supplied)
            if (profileId === 'gov') {
              delete toolArgs.agentId;
              if (portalToken?.userId) {
                const agentId = await resolveAgentId(portalToken.userId);
                if (!agentId) {
                  return { content: [{ type: 'text', text: JSON.stringify({
                    error: 'agent_resolution_failed',
                    message: 'Could not resolve agent identity. Gov service may be unavailable.',
                  }) }] };
                }
                toolArgs.agentId = agentId;

                // Tier check for tier-gated gov tools (BUG-mutes-001).
                // Tools not in TOOL_MIN_TIER return allow=true automatically.
                const tier = await getAgentTier(agentId);
                const tierResult = checkTier(tier, name);
                if (!tierResult.allow) {
                  return { content: [{ type: 'text', text: JSON.stringify(tierResult.errorBody) }] };
                }
              }
            }

            // Pre-check: can user afford this tool?
            if (portalToken?.userId) {
              // For gov tools: fetch agent reputation for discount calculation
              let agentReputation: number | undefined;
              if (profileId === 'gov' && toolArgs.agentId) {
                const rep = await getAgentReputation(toolArgs.agentId as string);
                if (rep !== null) agentReputation = rep;
              }

              const check = await toolCheck(portalToken.userId, costKey, agentReputation);
              if (check) {
                if (!check.allowed) {
                  return { content: [{ type: 'text', text: JSON.stringify({
                    error: 'Insufficient credits',
                    cost_key: costKey,
                    effective_cost: check.effectiveCost,
                    balance: check.creditsBalance ?? 0,
                    reason: check.reason,
                  }) }] };
                }
                creditsCharged = check.effectiveCost;
              }
              // check === null → Portal unavailable, fallback to legacy below
            }

            // Execute tool inside usage-tracking async context. Any
            // ctx.modelRouter.complete / ctx.geminiEmbedder.embed calls
            // (and shared helpers like embedQuery) record into `usage`
            // via AsyncLocalStorage lookup.
            toolResult = await withUsageTracker(usage, () => originalHandler(...handlerArgs));

            // Post-deduct: charge user
            if (portalToken?.userId && portalToken?.tokenId) {
              if (creditsCharged !== null) {
                // New billing: tool-deduct with effective_cost
                const deductResult = await toolDeduct(
                  portalToken.userId, portalToken.tokenId, costKey, creditsCharged, ip, userAgent,
                );
                if (deductResult) creditsCharged = deductResult.creditsCharged;
              } else {
                // Fallback: legacy deduct-credit (transition period)
                const legacyResult = await deductCredit(
                  portalToken.userId, portalToken.tokenId, name, ip, userAgent,
                );
                creditsCharged = legacyResult?.creditsCharged ?? 1;
              }
            }

            return toolResult;
          } catch (err) {
            isError = true;
            errorMsg = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            const durationMs = Date.now() - start;
            recordInvocation(profileId, name, durationMs, isError);

            const { resultCount, topResults } = extractResultSummary(toolResult);

            const usageSnapshot = usage.snapshot();

            logRequest({
              timestamp: new Date().toISOString(),
              userId: portalToken?.userId ?? null,
              tokenId: portalToken?.tokenId ?? null,
              tokenType: portalToken?.tokenType ?? null,
              ip,
              userAgent,
              profile: profileId,
              tool: name,
              arguments: toolArgs,
              resultCount,
              topResults,
              durationMs,
              creditsCharged,
              error: errorMsg,
              ...usageSnapshot,
            });

            // Per-call Redis counter increment for daily aggregation
            // (openarx-um8r). Fire-and-forget — JSONL retains full
            // forensic data, Redis is purely a fast-path accumulator.
            void incrementCallCounters({
              costKey,
              profile: profileId,
              isError,
              durationMs,
              creditsCharged,
              usage: usageSnapshot,
            });
          }
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalTool as any)(...args);
    } as typeof server.tool;

    profile.registerTools(server, ctx);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── Pipeline API routes (proxied to runner daemon) ─────────────

  registerPipelineRoutes(app);
  registerInternalRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  // ── Portal document processing queue ──────────────────────────

  ctx.portalDocQueue.init().catch((err) => {
    log('Portal doc queue init failed (non-fatal):', err instanceof Error ? err.message : err);
  });

  // ── Start ──────────────────────────────────────────────────────

  const profiles = getAllProfiles();
  const server = app.listen(PORT, HOST, () => {
    log(`Listening on http://${HOST}:${PORT}`);
    for (const p of profiles) {
      log(`  ${p.id}: http://${HOST}:${PORT}/${p.id}/mcp — ${p.description}`);
    }
    log(`Health:   http://${HOST}:${PORT}/health`);
    log(`Versions: http://${HOST}:${PORT}/versions`);
    log(`Metrics:  http://${HOST}:${PORT}/metrics`);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  const shutdown = async (): Promise<void> => {
    log('Shutting down...');
    server.close();
    await ctx.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Cluster mode ────────────────────────────────────────────────

import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const MCP_WORKERS = parseInt(process.env.MCP_WORKERS ?? '1', 10);

if (MCP_WORKERS > 1 && cluster.isPrimary) {
  log(`Cluster: starting ${MCP_WORKERS} workers`);
  for (let i = 0; i < MCP_WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    log(`Worker ${worker.process.pid} exited (code ${code}), restarting...`);
    cluster.fork();
  });
  // Cost rollup runs ONLY in primary (singleton in cluster mode).
  // Workers don't run it to avoid duplicate UPSERTs to Postgres.
  // See lib/cost-rollup.ts and docs/mcp_cost_tracking.md.
  startRollupTimer();
} else {
  main().catch((err: unknown) => {
    log('Fatal error:', err);
    process.exit(1);
  });
  // Single-process mode (MCP_WORKERS=1): no primary/worker split, the
  // sole process serves HTTP AND runs the rollup timer.
  if (MCP_WORKERS <= 1) startRollupTimer();
}
