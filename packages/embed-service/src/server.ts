import Fastify, { type FastifyInstance } from 'fastify';
import { chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import type { EmbedCache } from './cache.js';
import type { EmbedRouter } from './router.js';
import type { EmbedRequest, SupportedModel } from './handlers/types.js';
import {
  providerErrorsTotal,
  registry,
  requestDurationSeconds,
  requestsTotal,
} from './metrics.js';

const SUPPORTED: ReadonlyArray<SupportedModel> = [
  'specter2',
  'gemini-embedding-2-preview',
];

export function buildServer(
  cfg: Config,
  cache: EmbedCache,
  router: EmbedRouter,
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
    };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.post('/embed', async (req, reply) => {
    const body = req.body as Partial<EmbedRequest> | undefined;
    if (!body || !Array.isArray(body.texts) || body.texts.length === 0) {
      return reply.code(400).send({ error: 'texts[] is required and must be non-empty' });
    }
    if (!body.model || !SUPPORTED.includes(body.model as SupportedModel)) {
      return reply.code(400).send({
        error: `model must be one of: ${SUPPORTED.join(', ')}`,
      });
    }
    for (const t of body.texts) {
      if (typeof t !== 'string') {
        return reply.code(400).send({ error: 'texts[] must contain only strings' });
      }
    }

    const model = body.model as SupportedModel;
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
