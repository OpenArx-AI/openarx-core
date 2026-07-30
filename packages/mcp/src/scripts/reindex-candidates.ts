/**
 * Re-index candidate selector (openarx-1nvk).
 *
 * Surfaces abstract_only documents most requested by agents (from the
 * document_demand rollup) — the natural input for the next full-text re-index
 * wave. Internal ops tool; read-only.
 *
 *   tsx src/scripts/reindex-candidates.ts [--since-days 90] [--min 3] [--limit 100]
 *
 * Output is a ranked table + a space-separated list of arxiv ids for easy
 * hand-off to the force_full downloaded-first flow.
 */
import { pool, query } from '@openarx/api';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return def;
}

interface Row {
  id: string;
  source_id: string;
  title: string;
  license: string | null;
  gd: string;
  gc: string;
  demand: string;
}

async function main(): Promise<void> {
  const sinceDays = arg('--since-days', 90);
  const min = arg('--min', 3);
  const limit = arg('--limit', 100);

  const { rows } = await query<Row>(
    `SELECT d.id, d.source_id, d.title, d.license,
            sum(dd.get_document_count)::text AS gd,
            sum(dd.get_chunks_count)::text   AS gc,
            sum(dd.get_document_count + dd.get_chunks_count)::text AS demand
     FROM document_demand dd
     JOIN documents d ON d.id = dd.document_id
     WHERE dd.day >= current_date - $1::int
       AND d.indexing_tier = 'abstract_only'
       AND d.status = 'ready'
       AND d.deleted_at IS NULL
     GROUP BY d.id, d.source_id, d.title, d.license
     HAVING sum(dd.get_document_count + dd.get_chunks_count) >= $2::int
     ORDER BY demand DESC
     LIMIT $3`,
    [sinceDays, min, limit],
  );

  console.log(
    `\nRe-index candidates — abstract_only, demand >= ${min} over last ${sinceDays}d (top ${limit})\n`,
  );
  if (rows.length === 0) {
    console.log('  (none — no abstract_only docs cross the threshold yet)\n');
    await pool.end();
    return;
  }

  console.log('  demand  get_doc  get_chunks  arxiv          title');
  console.log('  ------  -------  ----------  -------------  -----');
  for (const r of rows) {
    console.log(
      `  ${r.demand.padStart(6)}  ${r.gd.padStart(7)}  ${r.gc.padStart(10)}  ${(r.source_id ?? '').padEnd(13)}  ${r.title.slice(0, 70)}`,
    );
  }
  console.log(`\n${rows.length} candidate(s). arxiv ids:\n  ${rows.map((r) => r.source_id).join(' ')}\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('reindex-candidates failed:', err);
  process.exit(1);
});
