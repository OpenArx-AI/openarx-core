#!/usr/bin/env node
import { loadConfig } from './config.js';
import { EmbedCache } from './cache.js';
import { EmbedRouter } from './router.js';
import { TeiPool } from './tei-pool.js';
import { Qwen3Handler } from './handlers/qwen3-embedding-8b.js';
import { Gemini2Handler } from './handlers/gemini-2-preview.js';
import { buildServer, listenSocket, listenTcp } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const cache = new EmbedCache(cfg.redisCacheUrl, cfg.cacheTtlSeconds, cfg.disableCache);

  const router = new EmbedRouter(cache);
  // qwen3-embedding-8b @768 — the sole 768-dim model since the embedding_qwen_migration.
  // The specter2 handler and its self-hosted inference are gone; requests naming the old model
  // are resolved to this one at the API boundary (MODEL_ALIASES), because the physical Qdrant
  // named vector is still called "specter2" and now holds qwen vectors. Two interchangeable backends: the
  // rented-GPU TEI pool (bulk; registered at runtime via /admin/backends, or seeded from
  // TEI_URLS) and OpenRouter (operational/fallback). Both run the identical vector recipe.
  const teiPool = new TeiPool(
    cfg.teiSeedUrls.map((url) => ({ url, apiKey: cfg.teiApiKey, maxConcurrency: cfg.teiMaxConcurrency })),
  );
  router.register(new Qwen3Handler({
    openrouterApiKey: cfg.openrouterApiKey,
    teiPool,
  }));
  router.register(new Gemini2Handler({
    openrouterApiKey: cfg.openrouterApiKey,
    serviceAccountKeyFile: cfg.vertexSaKeyFile,
    googleCloudProject: cfg.googleCloudProject,
    googleCloudLocation: cfg.googleCloudLocation,
    concurrencyLimit: cfg.gemini2ConcurrencyLimit,
    vertexRatePerMinute: cfg.gemini2VertexRatePerMinute,
  }));

  // Fastify can't listen on multiple addresses from a single instance,
  // so build two instances that share routing logic — one for the Unix
  // socket (primary IPC), one for TCP (local tests/metrics scrape).
  const socketApp = buildServer(cfg, cache, router, teiPool);
  await listenSocket(socketApp, cfg.socketPath);

  const tcpApp = cfg.tcpPort > 0 ? buildServer(cfg, cache, router, teiPool) : null;
  if (tcpApp) {
    await listenTcp(tcpApp, cfg.tcpHost, cfg.tcpPort);
  }

  const shutdown = async (sig: string) => {
    socketApp.log.info(`received ${sig}, shutting down`);
    await socketApp.close();
    if (tcpApp) await tcpApp.close();
    teiPool.destroy();
    await cache.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err) => {
  console.error('[embed-service] fatal:', err);
  process.exit(1);
});
