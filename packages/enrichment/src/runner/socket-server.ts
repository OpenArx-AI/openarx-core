/**
 * Socket server for enrichment runner — IPC via Unix domain socket.
 *
 * Commands: status, stop, stats
 * Protocol: newline-delimited JSON (same as main runner).
 */

import { createServer, Server, Socket } from 'node:net';
import { mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EnrichmentRunner } from './EnrichmentRunner.js';

interface Command {
  type: string;
}

interface Response {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class EnrichmentSocketServer {
  private server: Server | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly runner: EnrichmentRunner,
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });

    try { await unlink(this.socketPath); } catch { /* stale socket */ }

    this.server = createServer((conn: Socket) => {
      let buffer = '';

      conn.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleMessage(line, conn);
        }
      });

      conn.on('error', () => { /* client disconnected */ });
    });

    this.server.listen(this.socketPath, () => {
      console.log(`[enrichment-runner] Socket listening on ${this.socketPath}`);
    });

    this.server.on('listening', async () => {
      try { await chmod(this.socketPath, 0o660); } catch { /* ok */ }
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleMessage(line: string, conn: Socket): void {
    let cmd: Command;
    try {
      cmd = JSON.parse(line) as Command;
    } catch {
      this.send(conn, { ok: false, error: 'Invalid JSON' });
      return;
    }

    this.dispatch(cmd).then(
      (resp) => this.send(conn, resp),
      (err) => this.send(conn, { ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  private async dispatch(cmd: Command): Promise<Response> {
    switch (cmd.type) {
      case 'status':
        return { ok: true, data: this.runner.status() };

      case 'stats':
        return { ok: true, data: this.runner.stats() };

      case 'stop':
        await this.runner.stop();
        return { ok: true, data: this.runner.status() };

      default:
        return { ok: false, error: `Unknown command: ${cmd.type}` };
    }
  }

  private send(conn: Socket, resp: Response): void {
    try { conn.write(JSON.stringify(resp) + '\n'); } catch { /* disconnected */ }
  }
}
