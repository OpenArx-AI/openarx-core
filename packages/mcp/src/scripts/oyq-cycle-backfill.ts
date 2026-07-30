/**
 * §12.1 (oyq) cycle-label back-fill — normalize `run.cycle` on EXISTING run nodes to the canonical
 * INTEGER + add `run.cycle_name` + the queryable scalars.
 *
 * SAFETY: `run` is a PROCESS node (opaque, NOT §4.3-hashed) — this touches ONLY run nodes. Claim
 * `cycle_context.cycle_type` (frozen inside existing claim ids) is NEVER touched (a different node
 * type; the MATCH is `(:run)` only). Any label that does not map cleanly by the §12.1 table is
 * REPORTED, never guessed (a null from normalizeCycle → surfaced, not invented). Idempotent /
 * re-runnable (already-normalized runs are skipped). Independent of the hxc co-deploy.
 *
 * Existing runs are MIXED (contracts): c3/c4/c8 wrote numbers, c1/c2/c5/c6/c9 wrote names
 * ('Cycle 1: Discovery' … 'Review/Integration') — normalizeCycle handles both by the table.
 *
 * Run ON S1 with the prod .env sourced (Neo4j loopback):
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/oyq-cycle-backfill.ts verify
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/oyq-cycle-backfill.ts execute
 */
import { getNeo4jDriver, neoPut, closeNeo4j } from '@openarx/api';
import { normalizeCycle } from '@openarx/methodist';

interface RunRow {
  run_id: string;
  data: Record<string, unknown>;
}

async function loadRuns(): Promise<RunRow[]> {
  const session = getNeo4jDriver().session();
  try {
    const r = await session.run('MATCH (r:run) RETURN r.run_id AS run_id, r._data AS data');
    return r.records.map((rec) => ({
      run_id: rec.get('run_id') as string,
      data: JSON.parse((rec.get('data') as string) ?? '{}') as Record<string, unknown>,
    }));
  } finally {
    await session.close();
  }
}

async function backfill(execute: boolean): Promise<void> {
  const runs = await loadRuns();
  let touched = 0;
  let alreadyNormalized = 0;
  let noCycle = 0;
  const unmappable: Array<{ run_id: string; raw: unknown }> = [];

  for (const { run_id, data } of runs) {
    const raw = data.cycle;
    if (raw === undefined || raw === null) {
      noCycle++;
      continue;
    }
    const norm = normalizeCycle(raw);
    if (!norm) {
      unmappable.push({ run_id, raw });
      continue;
    }
    // Already canonical? cycle is the exact integer AND cycle_name matches → skip (idempotent).
    if (data.cycle === norm.cycle && data.cycle_name === norm.cycle_name) {
      alreadyNormalized++;
      continue;
    }
    if (execute) {
      const next = { ...data, cycle: norm.cycle, cycle_name: norm.cycle_name };
      await neoPut('run', 'run_id', run_id, next, {
        credential_id: String(data.credential_id ?? ''),
        status: String(data.status ?? ''),
        cycle: norm.cycle,
        cycle_name: norm.cycle_name,
      });
    }
    touched++;
  }

  console.log(
    JSON.stringify(
      {
        stage: execute ? 'execute' : 'verify',
        totalRuns: runs.length,
        noCycle,
        alreadyNormalized,
        [execute ? 'updated' : 'wouldUpdate']: touched,
        unmappableCount: unmappable.length,
        unmappable,
      },
      null,
      2,
    ),
  );
  if (unmappable.length > 0) {
    console.log('⚠ UNMAPPABLE cycle labels above — report to the methodist; do NOT guess a value.');
  }
  await closeNeo4j();
  process.exit(0);
}

const stage = process.argv[2];
if (stage === 'verify') {
  void backfill(false).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else if (stage === 'execute') {
  void backfill(true).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error('usage: oyq-cycle-backfill.ts <verify|execute>');
  process.exit(1);
}
