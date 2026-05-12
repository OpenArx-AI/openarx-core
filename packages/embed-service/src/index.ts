#!/usr/bin/env node
import { loadConfig } from './config.js';
import { EmbedCache } from './cache.js';
import { EmbedRouter } from './router.js';
import { Specter2Handler } from './handlers/specter2.js';
import { Gemini2Handler } from './handlers/gemini-2-preview.js';
import { buildServer, listenSocket, listenTcp } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const cache = new EmbedCache(cfg.redisCacheUrl, cfg.cacheTtlSeconds, cfg.disableCache);

  const router = new EmbedRouter(cache);
  router.register(new Specter2Handler(
    cfg.specter2Url,
    undefined,
    cfg.specter2ServerUrls,
  ));
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
  const socketApp = buildServer(cfg, cache, router);
  await listenSocket(socketApp, cfg.socketPath);

  const tcpApp = cfg.tcpPort > 0 ? buildServer(cfg, cache, router) : null;
  if (tcpApp) {
    await listenTcp(tcpApp, cfg.tcpHost, cfg.tcpPort);
  }

  const shutdown = async (sig: string) => {
    socketApp.log.info(`received ${sig}, shutting down`);
    await socketApp.close();
    if (tcpApp) await tcpApp.close();
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
