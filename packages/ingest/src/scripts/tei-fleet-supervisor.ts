/**
 * tei-fleet-supervisor — S1-side fleet manager for the qwen GPU-pool bulk (epic
 * openarx-lsqk, gtwh). For each rented-GPU backend it keeps the SSH tunnel alive and the
 * backend registered in the embed-service router, so a multi-day bulk survives tunnel
 * drops without human intervention.
 *
 * Per backend:
 *   • spawn `ssh -N -L <localPort>:localhost:80 ... root@<sshHost>` and RESPAWN it on exit
 *     (backoff) — the S1 half of the two-level fault tolerance (the provider runs a per-box
 *     TEI respawn; this side reopens the tunnel);
 *   • once the tunnel + TEI /health are up, register it via POST /admin/backends, and keep
 *     it registered (idempotent re-register survives an embed-service restart);
 *   • the router's own health-check ejects a dead backend within seconds and re-admits it
 *     once the tunnel is back — this supervisor only guarantees the tunnel comes back.
 *
 * On SIGINT/SIGTERM: deregister every backend, then kill the tunnels (clean teardown).
 *
 * Usage:
 *   pnpm --filter @openarx/ingest run tei-fleet-supervisor -- \
 *     --ssh-key /root/.ssh/id_ed25519 \
 *     --backends 8000:gpu-host-a.example:22001:8,8001:gpu-host-b.example:22002:8
 *   ( <localPort>:<sshHost>:<sshPort>[:<maxConcurrency>], comma-separated )
 *   Env: CORE_INTERNAL_SECRET (required to register), EMBED_SERVICE_URL (default 127.0.0.1:3400).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('tei-fleet-supervisor');

const RESPAWN_DELAY_MS = 2_000;
const ENSURE_REGISTERED_INTERVAL_MS = 30_000;
const HEALTH_POLL_MS = 2_000;

export interface BackendCfg {
  localPort: number;
  sshHost: string;
  sshPort: number;
  maxConcurrency?: number;
}

export interface SupervisorConfig {
  embedUrl: string;
  secret: string;
  sshKey: string;
  register: boolean;
  backends: BackendCfg[];
}

/** Parse `<localPort>:<sshHost>:<sshPort>[:<maxConcurrency>]` tokens. Throws on malformed
 *  input rather than silently dropping a GPU from the fleet. */
export function parseBackends(spec: string): BackendCfg[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const parts = tok.split(':');
      if (parts.length < 3 || parts.length > 4) {
        throw new Error(`bad backend token "${tok}" — want localPort:sshHost:sshPort[:maxConcurrency]`);
      }
      const [localPort, sshHost, sshPort, maxConcurrency] = parts;
      const lp = Number(localPort);
      const sp = Number(sshPort);
      if (!Number.isInteger(lp) || lp <= 0) throw new Error(`bad localPort in "${tok}"`);
      if (!sshHost) throw new Error(`empty sshHost in "${tok}"`);
      if (!Number.isInteger(sp) || sp <= 0) throw new Error(`bad sshPort in "${tok}"`);
      const cfg: BackendCfg = { localPort: lp, sshHost, sshPort: sp };
      if (maxConcurrency !== undefined) {
        const mc = Number(maxConcurrency);
        if (!Number.isInteger(mc) || mc <= 0) throw new Error(`bad maxConcurrency in "${tok}"`);
        cfg.maxConcurrency = mc;
      }
      return cfg;
    });
}

function parseArgs(): SupervisorConfig {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const backendsSpec = get('--backends');
  if (!backendsSpec) throw new Error('--backends is required (localPort:sshHost:sshPort[:maxConc], comma-sep)');
  return {
    embedUrl: get('--embed-url') ?? process.env.EMBED_SERVICE_URL ?? 'http://127.0.0.1:3400',
    secret: process.env.CORE_INTERNAL_SECRET ?? '',
    sshKey: get('--ssh-key') ?? '/root/.ssh/id_ed25519',
    register: !args.includes('--no-register'),
    backends: parseBackends(backendsSpec),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Tunnel {
  private child: ChildProcess | null = null;
  private shuttingDown = false;
  private registered = false;

  constructor(private readonly cfg: SupervisorConfig, private readonly be: BackendCfg) {}

  private label(): string {
    return `:${this.be.localPort}→${this.be.sshHost}:${this.be.sshPort}`;
  }

  private url(): string {
    return `http://localhost:${this.be.localPort}`;
  }

  start(): void {
    this.spawn();
  }

  private spawn(): void {
    if (this.shuttingDown) return;
    const sshArgs = [
      '-N',
      '-L', `${this.be.localPort}:localhost:80`,
      '-i', this.cfg.sshKey,
      '-p', String(this.be.sshPort),
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      `root@${this.be.sshHost}`,
    ];
    log.info({ be: this.label() }, 'opening tunnel');
    const child = spawn('ssh', sshArgs, { stdio: 'ignore' });
    this.child = child;
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.shuttingDown) return;
      log.warn({ be: this.label(), code, signal }, 'tunnel exited — respawning');
      setTimeout(() => this.spawn(), RESPAWN_DELAY_MS);
    });
  }

  /** True when TEI answers /health 200 through the tunnel. */
  private async healthy(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5_000);
      const r = await fetch(`${this.url()}/health`, { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  }

  private async register(): Promise<void> {
    const r = await fetch(`${this.cfg.embedUrl}/admin/backends`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': this.cfg.secret },
      body: JSON.stringify({ url: this.url(), maxConcurrency: this.be.maxConcurrency }),
    });
    if (!r.ok) throw new Error(`register ${this.url()} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    this.registered = true;
    log.info({ be: this.label() }, 'registered in router');
  }

  private async deregisterByUrl(): Promise<void> {
    try {
      const list = (await (await fetch(`${this.cfg.embedUrl}/admin/backends`, {
        headers: { 'X-Internal-Secret': this.cfg.secret },
      })).json()) as { backends?: Array<{ id: string; url: string }> };
      const mine = (list.backends ?? []).find((b) => b.url === this.url());
      if (mine) {
        await fetch(`${this.cfg.embedUrl}/admin/backends/${mine.id}`, {
          method: 'DELETE',
          headers: { 'X-Internal-Secret': this.cfg.secret },
        });
        log.info({ be: this.label(), id: mine.id }, 'deregistered from router');
      }
    } catch (err) {
      log.warn({ be: this.label(), error: (err as Error).message }, 'deregister failed (continuing teardown)');
    }
  }

  /** Keep the backend registered while healthy — survives an embed-service restart that
   *  drops the in-memory registry. The router itself handles eject/re-admit by health. */
  async supervise(): Promise<void> {
    while (!this.shuttingDown) {
      if (this.cfg.register && (await this.healthy())) {
        try {
          // addBackend is idempotent by URL, so an unconditional register both first-time
          // registers and re-registers after a router restart.
          await this.register();
        } catch (err) {
          this.registered = false;
          log.warn({ be: this.label(), error: (err as Error).message }, 'register attempt failed — retry next cycle');
        }
      }
      await sleep(this.registered ? ENSURE_REGISTERED_INTERVAL_MS : HEALTH_POLL_MS);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.cfg.register) await this.deregisterByUrl();
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs();
  if (cfg.register && !cfg.secret) {
    throw new Error('CORE_INTERNAL_SECRET is required to register backends (or pass --no-register)');
  }
  log.info(
    { backends: cfg.backends.length, embedUrl: cfg.embedUrl, register: cfg.register },
    'starting tei-fleet-supervisor',
  );
  const tunnels = cfg.backends.map((be) => new Tunnel(cfg, be));
  for (const t of tunnels) {
    t.start();
    void t.supervise();
  }

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal: sig }, 'graceful shutdown — deregistering + closing tunnels');
    await Promise.all(tunnels.map((t) => t.shutdown()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive; supervise() loops run in the background.
  await new Promise(() => {});
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('tei-fleet-supervisor.ts')) {
  main().catch((err) => {
    log.error({ err }, 'tei-fleet-supervisor failed');
    process.exit(1);
  });
}
