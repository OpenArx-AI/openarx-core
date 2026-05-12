#!/usr/bin/env node
/**
 * Enrichment Runner Daemon — discovers OA alternatives for arxiv papers.
 *
 * Managed by systemd (openarx-enrichment-runner.service).
 * Socket: /run/openarx/enrichment-runner.sock
 */

import { EnrichmentRunner } from './EnrichmentRunner.js';
import { EnrichmentSocketServer } from './socket-server.js';

const SOCKET_PATH = process.env.ENRICHMENT_SOCKET ?? '/run/openarx/enrichment-runner.sock';

async function main(): Promise<void> {
  console.log('[enrichment-runner] Starting...');

  const runner = new EnrichmentRunner();
  const socketServer = new EnrichmentSocketServer(SOCKET_PATH, runner);

  await socketServer.start();
  await runner.start();

  console.log(`[enrichment-runner] Ready. Socket: ${SOCKET_PATH}`);

  const shutdown = async (): Promise<void> => {
    console.log('[enrichment-runner] Shutting down...');
    await runner.stop();
    await socketServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (err) => {
    console.error('[enrichment-runner] Unhandled rejection (non-fatal):', err instanceof Error ? err.message : err);
  });
}

main().catch((err) => {
  console.error('[enrichment-runner] Fatal:', err);
  process.exit(1);
});
