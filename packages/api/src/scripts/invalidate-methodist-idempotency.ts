#!/usr/bin/env node
/**
 * Drop cached checkpoint verdicts for a run so a hand-in can be judged again.
 *
 * WHY THIS EXISTS. A checkpoint verdict is cached under `run_id:stage:submission_hash`, and a
 * byte-identical re-submit replays it instead of re-judging. That is right when the verdict was
 * sound — it stops a mentee from shopping for a better answer. It is a trap when the verdict was
 * WRONG: the curator can annul it methodologically, but the system replays it forever, and the only
 * escape is to change the work itself to fit a complaint that should never have been made. A grader
 * fault then forces the mentee to accommodate it. (Found 2026-07-27 on run …bef672b8, where the
 * grader faulted the submission for an envelope it is never shown.)
 *
 * WHY GO IS DIFFERENT (openarx-methodist's framing, which is the real reason — the double-commit
 * below is only its symptom). Annulling a RETURN and annulling a GO are different acts:
 *   • A RETURN produced nothing. Removing it erases a judgement that should not have been made;
 *     nothing in the world depended on it, so a cache drop is the whole of the remedy.
 *   • A GO produced records in the graph that others may already cite. Its consequences are already
 *     in the world, so it cannot be taken back at all — it can only be CORRECTED the way the
 *     methodology corrects anything wrong: by supersede / a correcting relation, an open act that
 *     stays visible in the history. A silent delete would be a path for erasing knowledge that has
 *     already been used, which is precisely what the provenance design exists to prevent.
 * Hence GO entries are kept unless --include-go is passed explicitly, and the default run only
 * reports what it would do.
 *
 * This is a maintenance tool, not a surface: it exists so an operator can unstick a run today. The
 * durable mechanism (curator-initiated annulment that invalidates its own cache) is openarx-vpor's
 * sibling and goes through the contracts gate.
 *
 * Usage:
 *   node dist/scripts/invalidate-methodist-idempotency.js --run <run_id> [--stage N] [--include-go]
 *   ... --dry-run    # default: print what WOULD be removed, change nothing
 */
import { query } from '../db/pool.js';

interface Row {
  key: string;
  outcome: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runId = arg('run');
  const stage = arg('stage');
  const includeGo = argv.includes('--include-go');
  const apply = argv.includes('--apply');

  if (!runId) {
    console.error('usage: --run <run_id> [--stage N] [--include-go] [--apply]');
    process.exit(2);
  }

  // The key is `${run_id}:${stage}:${submission_hash}`; run ids themselves contain colons
  // (run:cred:<owner>:<uuid>), so match on the prefix rather than trying to split the key.
  const prefix = stage != null ? `${runId}:${stage}:` : `${runId}:`;
  const found = await query<Row>(
    `SELECT key, outcome FROM methodist_idempotency WHERE key LIKE $1 ORDER BY key`,
    [`${prefix}%`],
  );

  if (found.rows.length === 0) {
    console.log(`no cached verdicts for prefix ${prefix}`);
    return;
  }

  const verdictOf = (row: Row): string =>
    typeof row.outcome?.verdict === 'string' ? row.outcome.verdict : 'unknown';
  const removable = found.rows.filter((r) => includeGo || verdictOf(r) !== 'GO');
  const kept = found.rows.filter((r) => !removable.includes(r));

  console.log(`cached verdicts under ${prefix}: ${found.rows.length}`);
  for (const r of found.rows) {
    const mark = removable.includes(r) ? 'REMOVE' : 'keep  ';
    console.log(`  ${mark}  ${verdictOf(r).padEnd(7)} ${r.key}`);
  }
  if (kept.length > 0 && !includeGo) {
    console.log(
      `\n${kept.length} GO entr${kept.length === 1 ? 'y' : 'ies'} kept: each references a committed ` +
        `bundle, and re-judging one could commit it twice. Pass --include-go only if that is intended.`,
    );
  }

  if (!apply) {
    console.log(`\ndry run — nothing changed. Re-run with --apply to remove ${removable.length}.`);
    return;
  }

  let removed = 0;
  for (const r of removable) {
    const res = await query(`DELETE FROM methodist_idempotency WHERE key = $1`, [r.key]);
    removed += res.rowCount ?? 0;
  }
  // Report what the database actually did, not what was intended.
  console.log(`\nremoved ${removed} of ${removable.length} targeted entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
