/**
 * Structured logger for enrichment worker.
 * Uses pino with child logger pattern (same as @openarx/ingest).
 */

import pino from 'pino';

export const log = pino({
  name: 'enrichment',
  level: process.env.LOG_LEVEL ?? 'debug',
});

export function createChildLogger(component: string): pino.Logger {
  return log.child({ component: `enrichment:${component}` });
}
