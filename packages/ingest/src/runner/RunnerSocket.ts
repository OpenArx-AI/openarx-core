/**
 * RunnerSocket — IPC via Unix domain socket.
 *
 * Server side: listens on socket, dispatches commands to RunnerService.
 * Client side: connects, sends command JSON, reads response JSON.
 */

import { createServer, createConnection, Server, Socket } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RunnerService } from './RunnerService.js';
import type { RunnerCommand, RunnerResponse } from './types.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('runner-socket');

export class RunnerSocketServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly service: RunnerService;

  constructor(socketPath: string, service: RunnerService) {
    this.socketPath = socketPath;
    this.service = service;
  }

  async start(): Promise<void> {
    // Ensure directory exists
    await mkdir(dirname(this.socketPath), { recursive: true });

    // Remove stale socket
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.socketPath);
    } catch {
      // ignore
    }

    this.server = createServer((conn: Socket) => {
      let buffer = '';

      conn.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Protocol: newline-delimited JSON
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleMessage(line, conn);
        }
      });

      conn.on('error', (err) => {
        log.warn({ err: err.message }, 'Client connection error');
      });
    });

    this.server.listen(this.socketPath, () => {
      log.info({ socketPath: this.socketPath }, 'Socket server listening');
    });

    // Make socket accessible by openarx user
    this.server.on('listening', async () => {
      try {
        const { chmod } = await import('node:fs/promises');
        await chmod(this.socketPath, 0o660);
      } catch {
        // ignore
      }
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleMessage(line: string, conn: Socket): void {
    let cmd: RunnerCommand;
    try {
      cmd = JSON.parse(line) as RunnerCommand;
    } catch {
      this.sendResponse(conn, { ok: false, error: 'Invalid JSON' });
      return;
    }

    this.dispatch(cmd).then(
      (resp) => this.sendResponse(conn, resp),
      (err) => this.sendResponse(conn, { ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private async dispatch(cmd: RunnerCommand): Promise<RunnerResponse> {
    switch (cmd.type) {
      case 'ingest': {
        const run = cmd.retry
          ? await this.service.retry(cmd.limit)
          : await this.service.ingest(cmd.limit, cmd.direction, cmd.dateFrom, cmd.dateTo, cmd.strategy, cmd.bypassEmbedCache, cmd.categories);
        return { ok: true, data: run };
      }
      case 'stop': {
        const status = await this.service.stop();
        return { ok: true, data: status };
      }
      case 'status': {
        const status = await this.service.status();
        return { ok: true, data: status };
      }
      case 'coverage': {
        const cov = await this.service.coverage();
        return { ok: true, data: cov };
      }
      case 'history': {
        const runs = await this.service.history(cmd.limit);
        return { ok: true, data: runs };
      }
      case 'audit': {
        const result = await this.service.audit(cmd.days, cmd.date);
        return { ok: true, data: result };
      }
      case 'doctor': {
        const result = await this.service.doctor(cmd.fix, cmd.check, cmd.limit);
        return { ok: true, data: result };
      }
      default:
        return { ok: false, error: `Unknown command: ${(cmd as Record<string, unknown>).type}` };
    }
  }

  private sendResponse(conn: Socket, resp: RunnerResponse): void {
    try {
      conn.write(JSON.stringify(resp) + '\n');
    } catch {
      // client disconnected
    }
  }
}

/** Client: send a command to the runner daemon and get response */
export async function sendCommand(socketPath: string, cmd: RunnerCommand): Promise<RunnerResponse> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error('Timeout waiting for response'));
    }, 300_000); // 5 min for long ingest responses

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
          reject(new Error('Invalid response from daemon'));
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot connect to runner daemon: ${err.message}`));
    });
  });
}
