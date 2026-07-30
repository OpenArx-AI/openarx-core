import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import type { EmbedCache } from './cache.js';
import type { EmbedRouter } from './router.js';
import type { TeiPool } from './tei-pool.js';
import type { EmbedRequest } from './handlers/types.js';
import { MODEL_ALIASES, resolveModel } from './handlers/types.js';
import {
  providerErrorsTotal,
  registry,
  requestDurationSeconds,
  requestsTotal,
  teiBackendErrors,
  teiBackendHealthy,
  teiBackendInflight,
  teiBackendRequests,
  teiPoolBackends,
} from './metrics.js';

/** Names a request may use: the real models plus the legacy aliases resolved by resolveModel().
 *  `specter2` is accepted as an ALIAS only — see MODEL_ALIASES for why the name still appears. */
const ACCEPTED_MODELS: ReadonlyArray<string> = [
  'qwen3-embedding-8b',
  'gemini-embedding-2-preview',
  ...Object.keys(MODEL_ALIASES),
];

export function buildServer(
  cfg: Config,
  cache: EmbedCache,
  router: EmbedRouter,
  teiPool?: TeiPool,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,
    },
    bodyLimit: 8 * 1024 * 1024, // 8 MB — up to ~8k texts of ~1KB each
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url === '/metrics') return;
    const secret = req.headers['x-internal-secret'];
    if (!secret || secret !== cfg.internalSecret) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => {
    const redisOk = await cache.ping();
    return {
      status: redisOk ? 'ok' : 'degraded',
      redis: redisOk ? 'up' : 'down',
      models: router.models(),
      cache: cache.snapshot(),
      // Additive: per-backend GPU-pool state for qwen (omitted when no pool configured).
      // Console monitoring reads /health — existing fields are unchanged.
      tei_pool: teiPool ? teiPool.getPoolHealth() : undefined,
    };
  });

  app.get('/metrics', async (_req, reply) => {
    // Populate per-backend gauges from the pool at scrape time; reset first so a
    // deregistered backend's stale label-set doesn't linger.
    if (teiPool) {
      const h = teiPool.getPoolHealth();
      teiPoolBackends.set({ state: 'total' }, h.total);
      teiPoolBackends.set({ state: 'healthy' }, h.healthy);
      teiBackendHealthy.reset();
      teiBackendInflight.reset();
      teiBackendRequests.reset();
      teiBackendErrors.reset();
      for (const b of h.backends) {
        teiBackendHealthy.set({ id: b.id }, b.healthy ? 1 : 0);
        teiBackendInflight.set({ id: b.id }, b.inFlight);
        teiBackendRequests.set({ id: b.id }, b.requests);
        teiBackendErrors.set({ id: b.id }, b.errors);
      }
    }
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.post('/embed', async (req, reply) => {
    const body = req.body as Partial<EmbedRequest> | undefined;
    if (!body || !Array.isArray(body.texts) || body.texts.length === 0) {
      return reply.code(400).send({ error: 'texts[] is required and must be non-empty' });
    }
    const resolved = body.model ? resolveModel(body.model) : undefined;
    if (!resolved) {
      return reply.code(400).send({
        error: `model must be one of: ${ACCEPTED_MODELS.join(', ')}`,
      });
    }
    for (const t of body.texts) {
      if (typeof t !== 'string') {
        return reply.code(400).send({ error: 'texts[] must contain only strings' });
      }
    }

    // Route and report under the RESOLVED model, so an aliased request is answered honestly
    // ("you got qwen") rather than echoing a model that no longer exists.
    const model = resolved;
    const start = Date.now();
    try {
      const result = await router.embed({
        texts: body.texts,
        model,
        taskType: body.taskType,
        outputDimensionality: body.outputDimensionality,
        allowFallback: body.allowFallback,
        bypassCache: body.bypassCache,
      });
      requestsTotal.inc({ model, status: 'ok' });
      requestDurationSeconds.labels({ model }).observe((Date.now() - start) / 1000);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      req.log.error({ err, model }, `embed failed: ${msg}`);
      requestsTotal.inc({ model, status: 'error' });
      providerErrorsTotal.inc({ model, provider: 'all' });
      return reply.code(502).send({ error: 'embed failed', detail: msg });
    }
  });

  // ── Admin: runtime TEI-backend registry for the qwen GPU pool. Protected by the
  // X-Internal-Secret onRequest hook (only /health + /metrics are exempt). Lets the
  // operator add/replace a rented GPU mid-run without restarting the worker or service.
  app.get('/admin/backends', async () => {
    return teiPool ? teiPool.getPoolHealth() : { total: 0, healthy: 0, backends: [] };
  });

  app.post('/admin/backends', async (req, reply) => {
    if (!teiPool) return reply.code(503).send({ error: 'tei pool not configured' });
    const body = req.body as { url?: string; apiKey?: string; maxConcurrency?: number } | undefined;
    if (!body || typeof body.url !== 'string' || body.url.length === 0) {
      return reply.code(400).send({ error: 'url is required' });
    }
    const id = teiPool.addBackend({ url: body.url, apiKey: body.apiKey, maxConcurrency: body.maxConcurrency });
    return { id, pool: teiPool.getPoolHealth() };
  });

  app.delete('/admin/backends/:id', async (req, reply) => {
    if (!teiPool) return reply.code(503).send({ error: 'tei pool not configured' });
    const { id } = req.params as { id: string };
    if (!teiPool.removeBackend(id)) return reply.code(404).send({ error: `backend ${id} not found` });
    return { removed: id, pool: teiPool.getPoolHealth() };
  });

  return app;
}

/** Listen a built instance on a Unix socket. Creates parent dir + chmod 0660. */
export async function listenSocket(app: FastifyInstance, socketPath: string): Promise<void> {
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
  } catch {
    /* RuntimeDirectory usually handles this */
  }
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* noop */ }
  }
  await app.listen({ path: socketPath });
  try {
    chmodSync(socketPath, 0o660);
  } catch (err) {
    app.log.warn(`chmod socket failed: ${(err as Error).message}`);
  }
  app.log.info(`listening on unix:${socketPath}`);
}

export async function listenTcp(app: FastifyInstance, host: string, port: number): Promise<void> {
  await app.listen({ host, port });
  app.log.info(`listening on tcp://${host}:${port}`);
}
