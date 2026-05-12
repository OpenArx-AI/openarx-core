import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, query } from './pool.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureSchemaVersion(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      filename TEXT NOT NULL
    )
  `);
}

async function getAppliedVersions(): Promise<Set<number>> {
  const result = await query<{ version: number }>(
    'SELECT version FROM schema_version ORDER BY version',
  );
  return new Set(result.rows.map((r) => r.version));
}

async function run(): Promise<void> {
  console.log('Running migrations...');

  await ensureSchemaVersion();
  const applied = await getAppliedVersions();

  const files = await readdir(MIGRATIONS_DIR);
  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  let count = 0;
  for (const file of sqlFiles) {
    const versionMatch = file.match(/^(\d+)/);
    if (!versionMatch) continue;

    const version = Number(versionMatch[1]);
    if (applied.has(version)) {
      console.log(`  [skip] ${file} (already applied)`);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`  [apply] ${file}`);

    await query('BEGIN');
    try {
      await query(sql);
      await query(
        'INSERT INTO schema_version (version, filename) VALUES ($1, $2)',
        [version, file],
      );
      await query('COMMIT');
      count++;
    } catch (err) {
      await query('ROLLBACK');
      console.error(`  [error] ${file}:`, err);
      throw err;
    }
  }

  console.log(
    count > 0
      ? `Applied ${count} migration(s).`
      : 'No pending migrations.',
  );

  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
