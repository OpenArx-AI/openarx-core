import pg from 'pg';

const { Pool } = pg;

function buildConfig(): pg.PoolConfig {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, max: 10 };
  }
  return {
    host: process.env.PG_HOST ?? 'localhost',
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DB ?? 'openarx',
    user: process.env.PG_USER ?? 'openarx',
    password: process.env.PG_PASSWORD ?? 'openarx_dev',
    max: 10,
  };
}

export const pool = new Pool(buildConfig());

// Level 1: Pool-level error handler.
// Without this, pg-pool emits 'error' on idle client disconnect → Node.js
// treats it as unhandled event → process.exit(1). Pool auto-reconnects on
// next query, so we just log and move on.
pool.on('error', (err) => {
  console.error('[pg-pool] Idle client error (non-fatal):', err.message);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Level 3: Query-level retry on connection errors.
// If PG connection drops mid-query, retry up to 3 times with backoff.
// pg-pool creates a fresh connection automatically on next attempt.
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await pool.query<T>(text, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 3 && (msg.includes('Connection terminated') || msg.includes('connection lost') || msg.includes('ECONNRESET'))) {
        console.warn(`[pg-pool] Query failed (attempt ${attempt}/3), retrying in ${attempt}s: ${msg}`);
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
