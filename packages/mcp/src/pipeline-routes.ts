/**
 * Pipeline API routes — proxy to runner daemon via Unix socket.
 *
 * GET  /api/pipeline/status    → runner status
 * GET  /api/pipeline/coverage  → coverage data
 * GET  /api/pipeline/history   → run history
 * POST /api/pipeline/ingest    → start ingest
 * POST /api/pipeline/stop      → stop current run
 */

import { createConnection } from 'node:net';
import type { Express, Request, Response } from 'express';
import express from 'express';

const SOCKET_PATH = process.env.RUNNER_SOCKET ?? '/run/openarx/runner.sock';

interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function sendToRunner(cmd: Record<string, unknown>): Promise<RunnerResponse> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    let buffer = '';
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error('Runner timeout'));
    }, 30_000);

    conn.on('connect', () => {
      conn.write(JSON.stringify(cmd) + '\n');
    });

    conn.on('data', (data: Buffer) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(buffer.slice(0, idx)) as RunnerResponse);
        } catch {
          reject(new Error('Invalid response'));
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Runner not available: ${err.message}`));
    });
  });
}

export function registerPipelineRoutes(app: Express): void {
  const router = express.Router();
  router.use(express.json());

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const resp = await sendToRunner({ type: 'status' });
      res.json(resp);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/coverage', async (_req: Request, res: Response) => {
    try {
      const resp = await sendToRunner({ type: 'coverage' });
      res.json(resp);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/history', async (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit ?? '10'), 10);
    try {
      const resp = await sendToRunner({ type: 'history', limit });
      res.json(resp);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/ingest', async (req: Request, res: Response) => {
    const { limit = 100, direction, retry, dateFrom, dateTo, strategy, bypassEmbedCache, categories } = req.body as {
      limit?: number; direction?: string; retry?: boolean; dateFrom?: string; dateTo?: string;
      strategy?: string; bypassEmbedCache?: boolean; categories?: string[];
    };
    try {
      const resp = await sendToRunner({ type: 'ingest', limit, direction, retry, dateFrom, dateTo, strategy, bypassEmbedCache, categories });
      if (!resp.ok) {
        res.status(409).json(resp);
        return;
      }
      res.json(resp);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/stop', async (_req: Request, res: Response) => {
    try {
      const resp = await sendToRunner({ type: 'stop' });
      res.json(resp);
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use('/api/pipeline', router);
}
