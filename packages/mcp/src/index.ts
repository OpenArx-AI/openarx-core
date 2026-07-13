#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContext, type AppContext } from './context.js';
import { getProfile, getAllProfiles } from './profiles/registry.js';
import { isTokenTypeSufficient } from './profiles/types.js';
import { roleFor, V4_ROLES, type V4Role } from './profiles/v4/index.js';
import { logMethodistToolCall } from '@openarx/api';
import { requiredScope, SCOPE_READ, SCOPE_METHODIST } from './profiles/scopes.js';
import { registerInternalRoutes } from './internal-routes.js';
import { registerUploadRoutes } from './upload-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import { isPortalAuthEnabled, verifyToken, deductCredit, hasPermission, checkTier, toolCheck, toolDeduct, applyPublishRefund, credentialFromToken, type PublishRefundOp, type TokenInfo } from './portal-auth.js';
import { logRequest, extractResultSummary } from './request-logger.js';
import { getCostKey, isDryRunCall } from './cost-key.js';
import { resolveAgentId, getAgentReputation, getAgentTier } from './gov-identity.js';
import { UsageTracker, withUsageTracker } from './lib/usage-tracker.js';
import { incrementCallCounters } from './lib/cost-counters.js';
import { startRollupTimer } from './lib/cost-rollup.js';
import { incrementDemand, demandDocId } from './lib/demand-counters.js';
import { startDemandRollupTimer } from './lib/demand-rollup.js';
import { startMethodistRollupTimer } from './lib/methodist-rollup.js';

// openarx-1mu1 (apfh follow-up): the anti-gaming tool-log records a researcher's WORK-tool calls
// so the checkpoint crosscheck reconciles claimed_usage. The methodist MECHANISM doors are NOT
// work-tools the agent chose (the single `methodist` model door = the checkpoint/diagnose/ask
// mechanism; report_need/escalate/get_current_dose/get_my_development = protocol plumbing) — excluded,
// else the agent would have to claim them. BUT the methodist_* READ-doors (get/find/search/
// explore_topic, §12.5 scientific-reads) ARE chosen research tools (reading the layer-2 graph, like
// search/get_document) → they MUST be logged, else a genuine methodist_search/find is false-flagged
// as fabrication (claimed_not_logged) — the catch-22 that blocked the mandated c8 layer-2 probe.
// So exclude ONLY the mechanism doors; log everything else (Layer-1 tools AND the methodist_* reads).
const METHODIST_MECHANISM_DOORS = new Set([
  'methodist',
  'methodist_get_current_dose',
  'methodist_report_need',
  'methodist_escalate',
  'methodist_get_my_development',
]);

// Layer2 PG-graph consumers removed with the PG→Neo4j teardown (openarx-1woy): the embed
// worker (PG layer2_claims → Qdrant) + the §7.6 dedup consumer operated on the dropped
// layer2_* tables. The methodist path now writes claim vectors DIRECTLY to Qdrant (2c), and
// Neo4j is the canonical graph. The Qdrant Layer2VectorStore + buildClaimProjection stay
// (reused by 2c). Full worker/consumer FILE removal is a staged follow-up (openarx-1woy).
import { initLegalVersions } from './lib/legal-versions.js';

/**
 * Bind addresses, comma-separated (openarx-76fo). The service must NOT
 * listen on 0.0.0.0: the public interface is served via a reverse proxy on
 * loopback, and sibling services reach the internal API over a private
 * network interface — list exactly those addresses (e.g.
 * MCP_HOST=127.0.0.1,<private-ip>).
 */
const HOSTS = (process.env.MCP_HOST ?? '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
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

  // The live surface is the v4 role model (mcp_profiles_v4): two roles, gated by
  // token_type, no scopes. The v3 profiles remain as superseded compatibility
  // endpoints (not advertised — no v3 tokens exist post-cutover).
  const V4_ROLE_DESCRIPTIONS: Record<string, string> = {
    researcher:
      "The researcher role — the scientist's pass: document search + read, document publishing, the scientific graph read (get/find/search/explore_topic), and the methodist door group. Access is by role (token_type=researcher); scopes are abolished. Direct Layer-2 graph writes are NOT an agent surface — publication is a checkpoint consequence.",
    governance:
      'The governance role — membership, voting and governance, plus corpus read. Access is by role (token_type=governance). Distinct civic pass; no methodist doors.',
  };
  app.get('/versions', (_req: Request, res: Response) => {
    const profiles = Object.values(V4_ROLES).map((r) => ({
      id: r.token_type,
      name: r.name,
      description: V4_ROLE_DESCRIPTIONS[r.token_type] ?? r.name,
      version: r.version,
      url: `/${r.token_type}/mcp`,
      token_type: r.token_type,
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

  // Authorization Server Metadata — proxied from Portal so this endpoint
  // always reflects the canonical AS configuration without drift. We used to
  // hardcode this here, but Portal-side updates (new scopes, new auth methods,
  // service_documentation field, etc.) left this copy stale. Discovery is a
  // low-frequency event (once per client connection), so an extra localhost
  // hop to Portal is negligible.
  app.get('/.well-known/oauth-authorization-server', async (_req: Request, res: Response) => {
    try {
      const upstream = await fetch(`${PORTAL_ISSUER}/.well-known/oauth-authorization-server`, {
        signal: AbortSignal.timeout(5000),
      });
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      const body = await upstream.text();
      res.send(body);
    } catch (err) {
      console.error('[discovery-proxy] AS metadata fetch failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'discovery_proxy_error' });
    }
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

  // Protected Resource Metadata — tells clients this resource requires OAuth2.
  // Also handles path-specific variant (Inspector appends MCP path:
  // /.well-known/oauth-protected-resource/v1/mcp).
  //
  // scopes_supported lists the scopes a client can request to access THIS
  // resource (per RFC 9728 §3.2.1). We have three production profiles —
  // consumer (/v1) requires mcp:read, publisher (/pub) requires mcp:publish,
  // governance (/gov) requires mcp:governance. All three must be advertised
  // so clients know they can request the broader scopes.
  app.use('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: MCP_RESOURCE,
      authorization_servers: [PORTAL_ISSUER],
      scopes_supported: ['mcp:read', 'mcp:publish', 'mcp:governance'],
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
    // N-7 (§7.7): a 429 is a RETRYABLE throttle, never an auth failure. Shape it so
    // a client cannot confuse it with token expiry — a distinct `rate_limited` code,
    // an explicit `retryable` flag, and a Retry-After hint. (Batch/audit enumeration
    // is a supported pattern: the global list/enumerate reads page 200 at a time, so
    // a full-graph audit is a handful of calls, comfortably within the per-user window.)
    message: { error: 'rate_limited', retryable: true, message: `Rate limit exceeded (${max}/min) — transient throttle, retry shortly; do NOT re-authenticate.` },
    handler: (_req, res) => {
      log(`Rate limit hit: ${name}`);
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        error: 'rate_limited',
        reason: 'rate_limited',
        retryable: true,
        retry_after_seconds: 60,
        message: `Rate limit exceeded (${max}/min). This is a transient throttle, NOT an authentication error — wait and retry; do not re-authenticate. Audit enumeration is supported: use the paginated list_relations / enumerate_bundles / query_* reads (up to 200 per page).`,
      });
    },
  });

  app.use('/health', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/versions', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/metrics', createLimiter(RATE_LIMIT_PUBLIC, 'public'));
  app.use('/.well-known', createLimiter(RATE_LIMIT_PUBLIC, 'well-known'));
  app.use('/oauth', createLimiter(RATE_LIMIT_OAUTH, 'oauth'));
  app.use('/api/internal', createLimiter(RATE_LIMIT_INTERNAL, 'internal'));
  // Presigned upload PUT (xuqi) — self-authenticating, per-IP rate limited.
  app.put('/api/upload/:file_id', createLimiter(RATE_LIMIT_INTERNAL, 'upload'));

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
        || req.path.startsWith('/api/upload') // self-authenticating via HMAC URL (xuqi)
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
          // N-7 (§7.7): an upstream throttle/outage on token-verify is RETRYABLE,
          // NOT an auth failure — never 401 (which tells clients to re-authenticate).
          if (info.rateLimited) {
            res.setHeader('Retry-After', '5');
            res.status(429).json({ error: 'rate_limited', retryable: true, retry_after_seconds: 5, message: 'Token verification is rate-limited upstream — retry shortly; do NOT re-authenticate.' });
            return;
          }
          if (info.upstreamUnavailable) {
            res.setHeader('Retry-After', '5');
            res.status(503).json({ error: 'verifier_unavailable', retryable: true, retry_after_seconds: 5, message: 'Token verification is temporarily unavailable — retry shortly; do NOT re-authenticate.' });
            return;
          }
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

  // Unsupported HTTP methods on /:profile/mcp must return 405 Method Not
  // Allowed + Allow header per RFC 9110 §15.5.5 — not 404 (which would imply
  // the route doesn't exist at all). Mounted BEFORE the per-method handlers
  // so unknown methods short-circuit before auth / rate-limit / body-parser.
  // OPTIONS is already handled upstream by the CORS middleware. openarx-d30n /
  // QA WAVE2-002.
  app.all('/:profile/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' || req.method === 'OPTIONS') {
      next();
      return;
    }
    res.set('Allow', 'POST, OPTIONS');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Method ${req.method} not allowed` },
      id: null,
    });
  });

  // Content-Type guard: reject non-JSON before express.json() / envelope
  // validator run. Previously the SDK transport itself returned 415, but my
  // envelope validator (added for WAVE2-001) now intercepts the empty-body
  // case first and emits -32600 — wrong, distinguishable from envelope shape
  // errors. Explicit 415 + -32000 here preserves spec-correct behavior.
  // openarx-1ozx / QA WAVE2-004.
  const checkContentType = (req: Request, res: Response, next: NextFunction): void => {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.includes('application/json')) {
      res.status(415).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
        id: null,
      });
      return;
    }
    next();
  };

  // Route-scoped error handler: body-parser throws SyntaxError on malformed
  // JSON. Express's default would return an HTML 400 page; JSON-RPC clients
  // expect a JSON-RPC envelope with code -32700. Scoped to the MCP route only
  // so other endpoints (Portal HTML, internal API) keep their default behaviour.
  // openarx-1fcy / QA WAVE2-003.
  const handleJsonParseError = (
    err: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      return;
    }
    next(err);
  };

  // JSON-RPC envelope validator: valid JSON but malformed envelope shape
  // (missing method, wrong jsonrpc value, etc.) must be reported as -32600
  // Invalid Request per JSON-RPC 2.0 §5.1 — not -32700 (which is reserved for
  // genuine parse failures). openarx-wc9c / QA WAVE2-001.
  const validateJsonRpcEnvelope = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const sendInvalidRequest = (): void => {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      });
    };
    const checkOne = (msg: unknown): boolean => {
      if (msg === null || typeof msg !== 'object') return false;
      const m = msg as Record<string, unknown>;
      if (m.jsonrpc !== '2.0') return false;
      if (typeof m.method !== 'string') return false;
      if ('id' in m && m.id !== null && typeof m.id !== 'string' && typeof m.id !== 'number') {
        return false;
      }
      return true;
    };
    const body = req.body;
    if (Array.isArray(body)) {
      if (body.length === 0) {
        sendInvalidRequest();
        return;
      }
      for (const msg of body) {
        if (!checkOne(msg)) {
          sendInvalidRequest();
          return;
        }
      }
    } else if (body && typeof body === 'object') {
      if (!checkOne(body)) {
        sendInvalidRequest();
        return;
      }
    } else {
      sendInvalidRequest();
      return;
    }
    next();
  };

  // Body limit 80mb: content_archive_base64 is capped at 67M chars by zod
  // (openarx-contracts-nie7) + JSON envelope overhead. Express's default
  // 100kb made the archive field unusable beyond trivial files (413).
  app.post('/:profile/mcp', checkContentType, express.json({ limit: '80mb' }), handleJsonParseError, validateJsonRpcEnvelope, async (req: Request, res: Response) => {
    requestCount++;

    // SDK's StreamableHTTPServerTransport requires Accept to include BOTH
    // application/json AND text/event-stream (MCP spec 2025-03-26+). Registry
    // bots (Smithery, etc.) and many JSON-RPC clients send only
    // application/json, which produces a 406 with a non-JSON-RPC body — clients
    // misread that as serverInfo:null. Silently augment Accept here so the SDK
    // accepts the request and responds in SSE format. Modern JSON-RPC libraries
    // parse the SSE envelope and extract the JSON payload.
    //
    // Note: must mutate BOTH `req.headers` (for any Express middleware that
    // consults it) AND `req.rawHeaders` (the array @hono/node-server reads
    // when SDK's StreamableHTTPServerTransport converts the Node request to
    // a Web Standard Request internally — see hono's request.js, which
    // iterates `incoming.rawHeaders` and ignores `incoming.headers`).
    //
    // openarx-v9qh / QA P0-1.
    const accept = String(req.headers.accept ?? '');
    const hasJson = accept.includes('application/json');
    const hasSse = accept.includes('text/event-stream');
    if (!hasJson || !hasSse) {
      // Build augmented header preserving any other values the client sent
      const additions: string[] = [];
      if (!hasJson) additions.push('application/json');
      if (!hasSse) additions.push('text/event-stream');
      const augmented = accept.length > 0
        ? `${accept}, ${additions.join(', ')}`
        : additions.join(', ');
      req.headers.accept = augmented;
      const raw = req.rawHeaders;
      let found = false;
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i].toLowerCase() === 'accept') {
          raw[i + 1] = augmented;
          found = true;
          break;
        }
      }
      if (!found) {
        raw.push('Accept', augmented);
      }
    }

    const profileId = String(req.params.profile);
    const portalToken = (req as unknown as Record<string, unknown>)._portalToken as TokenInfo | undefined;

    // ── v4 role-gate (mcp_profiles_v4 §1/§2/§8) ────────────────────────────────
    // A token_type of researcher|governance IS the role — no scopes, no per-tool
    // permissions. TOLERANT dual-mode for the Phase 3 cutover: a token still carrying an
    // old type (consumer/publisher/gov_participant) or `scopes` (pre-Portal-v4) falls
    // through to the EXACT v3 path below, so Core deploys FIRST with zero breakage.
    const v4Role: V4Role | undefined = roleFor(portalToken?.tokenType ?? '');
    const isV4 = v4Role !== undefined;

    let effId: string;
    let effVersion: string;
    let effRegister: (server: McpServer, ctx: AppContext) => void;

    if (isV4) {
      // Facade-mirror compat (openarx-534w): a v4 token is served ITS OWN role's toolset
      // regardless of which facade URL it arrived on. This un-breaks external OAuth
      // connectors set up before the Phase 3 cutover against a now-deprecated facade
      // (/v1, /pub, /dev, /gov, /layer2): after the cutover their token became
      // token_type=researcher|governance, and the old strict gate 403'd every such request
      // (Claude surfaced it as "authorized but integration rejected credentials"). No
      // privilege change — the token only ever receives ITS OWN role's tools; a researcher
      // can never reach governance tools via /gov, nor vice-versa. Superseded facades are
      // kept alive as mirrors and retired later once deprecation-hit traffic falls to zero.
      if (profileId !== v4Role.token_type) {
        // Only genuinely-known endpoints are mirrored: a registered v3 facade
        // (v1/pub/dev/gov/layer2) or the other v4 role. An unknown path is still a 404,
        // exactly as the v3 branch treats it — the mirror must not turn typos into 200s.
        if (getProfile(profileId) === undefined && roleFor(profileId) === undefined) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: `Unknown profile: ${profileId}. GET /versions for available profiles.` },
            id: null,
          });
          return;
        }
        // Deprecated-facade hit by a v4 token: serve the role, but flag it (RFC 8594
        // Deprecation + successor Link) and log it, so we can measure who still uses the
        // old URL before removing it (mcp_profiles_v4 §8 amendment, openarx-534w).
        res.setHeader('Deprecation', 'true');
        res.setHeader('Link', `</${v4Role.token_type}/mcp>; rel="successor-version"`);
        log(`[deprecated-facade] v4 token role='${v4Role.token_type}' arrived on '/${profileId}/mcp' — served via role-mirror; connector should repoint to /${v4Role.token_type}/mcp`);
      }
      effId = v4Role.token_type;
      effVersion = v4Role.version;
      effRegister = (s, c) => v4Role.registerTools(s, c);
    } else {
      const profile = getProfile(profileId);
      if (!profile) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: `Unknown profile: ${profileId}. GET /versions for available profiles.` },
          id: null,
        });
        return;
      }
      // Check token type meets profile minimum (v3 only).
      if (portalToken && !isTokenTypeSufficient(portalToken.tokenType, profile.minTokenType)) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32003, message: `Token type '${portalToken.tokenType ?? 'unknown'}' insufficient for profile '${profileId}' (requires '${profile.minTokenType}')` },
          id: null,
        });
        return;
      }
      effId = profile.id;
      effVersion = profile.version;
      effRegister = (s, c) => profile.registerTools(s, c);
    }

    // gov economy logic (agentId resolution + tier) fires for the v3 `gov` endpoint
    // AND the v4 `governance` role — the economy axis is untouched by v4 (§8).
    const isGovSurface = profileId === 'gov' || profileId === 'governance';

    // Hybrid: we're architecturally stateless (a fresh transport per request,
    // no in-memory session state we care about), but spec-strict 2025-03-26+
    // MCP clients expect a Mcp-Session-Id header on the initialize response.
    // Setting sessionIdGenerator to a UUID generator makes the SDK include the
    // header, then we patch validateSession to a no-op so subsequent requests
    // (which the client may send with or without Mcp-Session-Id) are not
    // rejected for missing/mismatched session ID. openarx-hjek / QA P1-1.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const internalTransport = (transport as unknown as {
      _webStandardTransport: { validateSession: () => undefined };
    })._webStandardTransport;
    internalTransport.validateSession = () => undefined;

    const server = new McpServer({
      name: `openarx-${effId}`,
      version: effVersion,
    });

    // Wrap tool registration with metrics + portal credit deduction
    const originalTool = server.tool.bind(server);
    server.tool = function (name: string, ...rest: unknown[]) {
      // v3 scope-filter (mcp_profiles_v3.md §3/§4). SKIPPED for v4 — the role is the
      // gate (§2), everything in the role is visible, no per-tool sub-gate.
      if (!isV4) {
        // (1) Methodist tools are scope-gated on EVERY endpoint they're registered on
        //     (the unified-facade model, §4 + §3.3): they require the `methodist` scope,
        //     fail-CLOSED. So a working agent whose token GAINS methodist (via the
        //     publisher-class scope mapping) sees them on its EXISTING endpoint after a
        //     single reconnect — no new server/config. Absent scope → not in tools/list
        //     AND uncallable. A token without methodist (every current token) is
        //     unaffected — the methodist tools are simply invisible.
        if (requiredScope(name) === SCOPE_METHODIST) {
          const scopes = portalToken?.scopes;
          if (!Array.isArray(scopes) || !scopes.includes(SCOPE_METHODIST)) {
            return undefined as unknown as ReturnType<typeof originalTool>;
          }
        }
        // (2) On the researcher profile ADDITIONALLY scope-gate write:documents /
        //     write:layer2 (read is the floor; writes fail-CLOSED). Facade profiles
        //     (v1/pub/layer2) keep their existing minTokenType + hasPermission gating
        //     for non-methodist tools — no existing client's non-methodist list changes.
        if (effId === 'researcher') {
          const req = requiredScope(name);
          if (req !== SCOPE_READ && req !== SCOPE_METHODIST) {
            const scopes = portalToken?.scopes;
            if (!Array.isArray(scopes) || !scopes.includes(req)) {
              return undefined as unknown as ReturnType<typeof originalTool>;
            }
          }
        }
      }
      const args = [name, ...rest];
      const handlerIdx = args.findIndex((a, i) => i > 0 && typeof a === 'function');
      if (handlerIdx > 0) {
        const originalHandler = args[handlerIdx] as (...a: unknown[]) => Promise<unknown>;
        args[handlerIdx] = async (...handlerArgs: unknown[]) => {
          // Propagate the gateway-verified publisher identity onto the SDK
          // handler `extra`. The MCP SDK only exposes authInfo/requestInfo on
          // extra — never our req._portalToken — so publish tools that read
          // (extra)._portalToken.userId were always seeing undefined
          // (openarx-contracts-0fvo). userId MUST derive from the verified
          // Bearer here, NEVER from a tool argument (a tool arg could claim
          // another user's identity). extra is the last handler arg (the SDK
          // calls (args, extra) with a schema, or (extra) without one).
          if (portalToken) {
            const ex = handlerArgs[handlerArgs.length - 1];
            if (ex && typeof ex === 'object') {
              (ex as Record<string, unknown>)._portalToken = portalToken;
            }
          }

          // F2.3/Phase 3 live tool-log (bead openarx-4y79): record a researcher's WORK-tool
          // calls (not the methodist interface itself) so the checkpoint crosscheck
          // reconciles claimed_usage against real usage (§8 inv-4). Fire-and-forget —
          // a journal failure must never break the tool call.
          //   • apfh/openarx-1mu1: exclude ONLY the methodist MECHANISM doors (METHODIST_MECHANISM_DOORS:
          //     the bare `methodist` checkpoint/model door + the deterministic channels) — the door-call
          //     is the mechanism, not a tool the agent chose. The methodist_* READ-doors (get/find/
          //     search/explore_topic) ARE chosen research tools and DO get logged (else a genuine read
          //     is false-flagged as fabrication — the c8-probe catch-22). Prior code excluded the whole
          //     `methodist_*` prefix, which wrongly swallowed the read-doors.
          //   • 2f: key the log by the SAME credential the run node carries
          //     (credentialFromToken → the (userId,tokenId) composite), NOT the raw userId —
          //     else listRunToolLog (which looks up by run.credential_id) finds nothing.
          if (
            isV4 &&
            effId === 'researcher' &&
            portalToken?.userId &&
            !METHODIST_MECHANISM_DOORS.has(name)
          ) {
            void logMethodistToolCall(credentialFromToken(portalToken), name).catch((e) =>
              console.error('[methodist tool-log]', e instanceof Error ? e.message : e),
            );
          }

          // Token-level permission check (search perms + always-free tools).
          // Tier-gated gov tools return allow=true here — their tier check
          // happens after agentId resolution below. SKIPPED for v4 — permissions{}
          // is dropped (§8); the role gates access, tier/credit economy is kept.
          if (!isV4 && portalToken) {
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
          // dry_run (openarx-contracts-tof2): validation-only calls cost 0 —
          // skip the pre-check AND every deduction path below.
          const dryRun = isDryRunCall(name, toolArgs);

          // Per-request usage tracker for LLM/embed cost capture
          // (openarx-2a5f). Threaded via AsyncLocalStorage so all
          // descendant async calls in the handler can record without
          // explicit ctx threading.
          const usage = new UsageTracker();

          try {
            // For the governance surface: resolve agentId server-side (never trust client-supplied)
            if (isGovSurface) {
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
            if (portalToken?.userId && !dryRun) {
              // For gov tools: fetch agent reputation for discount calculation
              let agentReputation: number | undefined;
              if (isGovSurface && toolArgs.agentId) {
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
                // §23.5 W1: expose the pre-known effective cost to publish
                // tools (same extra-mechanism as _portalToken) so the internal
                // endpoint can compute exact credits_refunded in the envelope.
                const exCost = handlerArgs[handlerArgs.length - 1];
                if (exCost && typeof exCost === 'object') {
                  (exCost as Record<string, unknown>)._effectiveCost = check.effectiveCost;
                }
              }
              // check === null → Portal unavailable, fallback to legacy below
            }

            // Execute tool inside usage-tracking async context. Any
            // ctx.modelRouter.complete / ctx.geminiEmbedder.embed calls
            // (and shared helpers like embedQuery) record into `usage`
            // via AsyncLocalStorage lookup.
            toolResult = await withUsageTracker(usage, () => originalHandler(...handlerArgs));

            // Handler-level skip-billing marker (openarx-contracts-w3rr §7):
            // publish tools set __skipBilling on non-chargeable endpoint
            // responses (spam_rejected, consent errors, validation, 503 …) so
            // the agent isn't charged for a fixable rejection. Read it, then
            // strip it before the SDK serializes the result.
            let skipBilling = false;
            if (toolResult && typeof toolResult === 'object' && (toolResult as Record<string, unknown>).__skipBilling === true) {
              skipBilling = true;
              delete (toolResult as Record<string, unknown>).__skipBilling;
            }
            // §23.5 W2: Tier-2/3 publish outcomes tag a refund op the gateway
            // must send to Portal AFTER the full-cost deduct. Read + strip
            // (never serialize the marker to the client).
            // Honest logging: when the handler marked the call non-billable,
            // no deduct happens — the JSONL/rollup must show 0, not the
            // pre-check effectiveCost (found via QA ledger reconciliation).
            if (skipBilling) creditsCharged = 0;
            let refundOp: PublishRefundOp | null = null;
            if (toolResult && typeof toolResult === 'object' && (toolResult as Record<string, unknown>).__refundNotify) {
              refundOp = (toolResult as Record<string, unknown>).__refundNotify as PublishRefundOp;
              delete (toolResult as Record<string, unknown>).__refundNotify;
            }

            // Post-deduct: charge user (never for dry_run or a skip-billing
            // rejection — the legacy fallback below would otherwise charge
            // when creditsCharged stayed null)
            if (portalToken?.userId && portalToken?.tokenId && !dryRun && !skipBilling) {
              if (creditsCharged !== null) {
                // New billing: tool-deduct with effective_cost
                const deductResult = await toolDeduct(
                  portalToken.userId, portalToken.tokenId, costKey, creditsCharged, ip, userAgent,
                );
                if (deductResult) creditsCharged = deductResult.creditsCharged;
                // §23.5 W2: full cost deducted above; now notify Portal of the
                // Tier-2/3 ledger refund (idempotent on request_ref). Fire-and-
                // verify — applyPublishRefund retries + ALERTs on exhaustion.
                if (refundOp) {
                  const requestRef = randomUUID();
                  void applyPublishRefund(portalToken.userId, portalToken.tokenId, refundOp, requestRef);
                }
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

            // Per-document demand counter (openarx-1nvk) — only the two content-
            // read tools. Fire-and-forget Redis HINCRBY; rolled up to PG by
            // lib/demand-rollup.ts. Internal signal for re-index candidate
            // selection; never surfaced to agents.
            if (name === 'get_document' || name === 'get_chunks') {
              const demandDoc = demandDocId(toolArgs, topResults);
              if (demandDoc) void incrementDemand(name, demandDoc);
            }
          }
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalTool as any)(...args);
    } as typeof server.tool;

    effRegister(server, ctx);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Pipeline control-plane is NOT exposed over HTTP (openarx-76fo):
  // Console talks to the runner daemon directly via the unix socket
  // (/run/openarx/runner.sock). The old /api/pipeline/* gateway let any
  // valid Bearer (incl. consumer tokens) start/stop ingest runs.
  // Load required legal-consent versions for publish-document (uhlh §11);
  // installs SIGHUP hot-reload so a version bump needs no Core redeploy.
  initLegalVersions();

  registerInternalRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  // ── Portal document processing queue ──────────────────────────

  ctx.portalDocQueue.init().catch((err) => {
    log('Portal doc queue init failed (non-fatal):', err instanceof Error ? err.message : err);
  });

  // ── Start ──────────────────────────────────────────────────────

  const profiles = getAllProfiles();
  const servers = HOSTS.map((host) => {
    const server = app.listen(PORT, host, () => {
      log(`Listening on http://${host}:${PORT}`);
      for (const p of profiles) {
        log(`  ${p.id}: http://${host}:${PORT}/${p.id}/mcp — ${p.description}`);
      }
      log(`Health:   http://${host}:${PORT}/health`);
    });
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    return server;
  });

  const shutdown = async (): Promise<void> => {
    log('Shutting down...');
    for (const server of servers) server.close();
    await ctx.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Cluster mode ────────────────────────────────────────────────

import cluster from 'node:cluster';

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
  startDemandRollupTimer();
  startMethodistRollupTimer(); // 694n — hourly Neo4j claim breakdowns → PG rollup
  // Layer2 PG-graph consumers disabled — PG graph torn down (openarx-1woy).
} else {
  main().catch((err: unknown) => {
    log('Fatal error:', err);
    process.exit(1);
  });
  // Single-process mode (MCP_WORKERS=1): no primary/worker split, the
  // sole process serves HTTP AND runs the rollup timer.
  if (MCP_WORKERS <= 1) {
    startRollupTimer();
    startDemandRollupTimer();
    startMethodistRollupTimer(); // 694n
    // Layer2 PG-graph consumers disabled (openarx-1woy).
  }
}
