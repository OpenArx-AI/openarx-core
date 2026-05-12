/**
 * openarx enrichment — enrichment worker management.
 *
 * Subcommands:
 *   status   Runner state, uptime, progress
 *   stats    Detailed counters + rate limit info
 *   stop     Graceful stop
 */

import { createConnection } from 'node:net';

const SOCKET_PATH = process.env.ENRICHMENT_SOCKET ?? '/run/openarx/enrichment-runner.sock';

interface SocketResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function sendCommand(type: string): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH);
    let buffer = '';
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error('Timeout waiting for response'));
    }, 10_000);

    conn.on('connect', () => {
      conn.write(JSON.stringify({ type }) + '\n');
    });

    conn.on('data', (data: Buffer) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(buffer.slice(0, idx)) as SocketResponse);
        } catch {
          reject(new Error('Invalid response from enrichment runner'));
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot connect to enrichment runner: ${err.message}\nIs openarx-enrichment-runner service running?`));
    });
  });
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

async function enrichmentStatus(): Promise<void> {
  const resp = await sendCommand('status');
  if (!resp.ok) { console.error('Error:', resp.error); return; }

  const d = resp.data as Record<string, unknown>;
  const progress = d.progress as Record<string, number>;

  console.log(`Enrichment Runner: ${d.state}`);
  console.log(`Uptime: ${formatUptime(d.uptime_sec as number)}`);
  if (d.lastError) console.log(`Last error: ${d.lastError}`);
  console.log('');
  console.log('Progress:');
  console.log(`  processed:        ${progress.processed}`);
  console.log(`  enriched (OA):    ${progress.enriched}`);
  console.log(`  no DOI:           ${progress.noDoi}`);
  console.log(`  errors:           ${progress.errors}`);
  console.log(`  files downloaded: ${progress.filesDownloaded}`);
  console.log(`  reindex triggered:${progress.reindexTriggered}`);
}

async function enrichmentStats(): Promise<void> {
  const resp = await sendCommand('stats');
  if (!resp.ok) { console.error('Error:', resp.error); return; }

  const d = resp.data as Record<string, number>;

  console.log('Enrichment Stats:');
  console.log(`  processed:         ${d.processed}`);
  console.log(`  enriched (OA):     ${d.enriched}`);
  console.log(`  no DOI:            ${d.noDoi}`);
  console.log(`  errors:            ${d.errors}`);
  console.log(`  files downloaded:  ${d.filesDownloaded}`);
  console.log(`  reindex triggered: ${d.reindexTriggered}`);
}

async function enrichmentStop(): Promise<void> {
  console.log('Stopping enrichment runner...');
  const resp = await sendCommand('stop');
  if (!resp.ok) { console.error('Error:', resp.error); return; }

  const d = resp.data as Record<string, unknown>;
  console.log(`State: ${d.state}`);
}

export async function enrichment(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'status':
      await enrichmentStatus();
      break;
    case 'stats':
      await enrichmentStats();
      break;
    case 'stop':
      await enrichmentStop();
      break;
    default:
      console.error(`Unknown enrichment subcommand: ${subcommand ?? '(none)'}`);
      console.log('\nUsage: openarx enrichment status|stats|stop');
      process.exit(1);
  }
}
