#!/usr/bin/env node
/**
 * Pipeline Runner Daemon — listens on Unix socket for commands.
 *
 * Managed by systemd (openarx-runner.service).
 */

import { RunnerService } from '../runner/RunnerService.js';
import { RunnerSocketServer } from '../runner/RunnerSocket.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('runner');

const SOCKET_PATH = process.env.RUNNER_SOCKET ?? '/run/openarx/runner.sock';

async function main(): Promise<void> {
  log.info('Starting pipeline runner daemon...');

  const service = new RunnerService();
  await service.init();

  const socketServer = new RunnerSocketServer(SOCKET_PATH, service);
  await socketServer.start();

  log.info({ socketPath: SOCKET_PATH }, 'Runner daemon ready');

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...');
    await socketServer.stop();
    await service.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Level 2: Safety net for unhandled rejections.
  // Prevents stray promise rejections (e.g. from pg-pool, fetch, etc.)
  // from crashing the entire runner process mid-ingest.
  process.on('unhandledRejection', (err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Unhandled rejection (non-fatal, process continues)');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Runner daemon failed');
  process.exit(1);
});
