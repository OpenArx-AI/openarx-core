/**
 * §12.1 (28c) finalization back-fill — synthesize `version_closeout` activities for the
 * pre-R13 completed runs that finished ALL their stages BEFORE the version_closeout convention
 * existed (R13 = closeout-canon, v1.4-base wave). Those runs are genuinely done but carry no
 * native closeout, so the presence-derivation (`done = ∃ version_closeout`) would leave them
 * 'active'. This appends a durable, clearly-marked synthetic closeout so derivation is uniform.
 *
 * WHY THIS IS SAFE / CORRECT:
 *  - APPEND-ONLY: writes NEW `activity` nodes; never mutates a run, claim, or real closeout.
 *  - PRINCIPLED SELECTOR (methodist canon 0123, index-safe): a run qualifies IFF
 *      COUNT(distinct GO'd stages) === STAGE_COUNT_BY_CYCLE[cycle]  AND
 *      it has NO existing version_closeout (real or back-filled)   AND
 *      it is not on the EXCLUDE list.
 *    COUNT===stage_count is index-agnostic (c1 is the ONLY 0-indexed cycle: stages 0..6; all
 *    others 1-indexed) — comparing the NUMBER of GO'd stages to the cycle's stage-count avoids
 *    the 0/1 off-by-one entirely. Values are the git-constant stable map (identical v1.3→v1.7).
 *  - QUARANTINE EXCLUDED: 6c74e076 (session-integrity incident, addendum of 2a1baf21, deliberately
 *    never closed) is on EXCLUDE and also fails the selector (c6: 6 distinct GO ≠ 7) — belt+braces.
 *  - PROVENANCE MANDATORY: every synthetic closeout carries `backfilled:true` + a provenance block
 *    so methodist AAR/closure-quality analytics can EXCLUDE them (they are NOT real methodist
 *    closures). Derivation counts them uniformly (presence is the signal); the flag is analytics-only.
 *  - IDEMPOTENT: the activity `id` is deterministic per run → re-running execute MERGEs, never dups.
 *  - VERIFY→EXECUTE: `verify` is read-only and prints the exact candidate set; run it first and
 *    confirm the count is the audited 7 before `execute`. Execute writes ONLY selector-passing runs.
 *
 * Run ON S1 with the prod .env sourced (Neo4j loopback):
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/mark-final-backfill.ts verify
 *   pnpm --filter @openarx/mcp exec tsx src/scripts/mark-final-backfill.ts execute   # material — Vlad go
 */
import { getNeo4jDriver, neoPut, neoListActivitiesByType, closeNeo4j } from '@openarx/api';

/** git-constant stable map — number of stages per cycle (c7 RESERVED, absent). Index-safe:
 *  criterion compares COUNT(distinct GO'd stages) to this, never a stage-number. */
const STAGE_COUNT_BY_CYCLE: Record<number, number> = {
  1: 7,
  2: 8,
  3: 6,
  4: 7,
  5: 8,
  6: 7,
  8: 7,
  9: 7,
};

/** Deliberate exclusions (never back-fill), matched by run_id substring. 6c74e076 = quarantined
 *  session-integrity incident (methodist 0123). Also fails the selector, kept here as belt+braces. */
const EXCLUDE_SUBSTRINGS = ['6c74e076'];

const EXPECTED_BACKFILL_COUNT = 7; // audited tail; verify must match before execute.

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

/** run_ids that already carry a non-superseded version_closeout (real OR back-filled) — excluded. */
async function alreadyClosedRunIds(): Promise<Set<string>> {
  const acts = await neoListActivitiesByType('version_closeout');
  const s = new Set<string>();
  for (const a of acts) {
    if (a && a.is_superseded !== true && typeof a.run_id === 'string') s.add(a.run_id);
  }
  return s;
}

interface Candidate {
  run_id: string;
  cycle: number;
  distinctGo: number;
  stageCount: number;
  credential_id: string;
}

function distinctGoCount(data: Record<string, unknown>): number {
  const gm = Array.isArray(data.go_marks) ? (data.go_marks as unknown[]) : [];
  return new Set(gm.map((s) => String(s))).size;
}

async function run(execute: boolean): Promise<void> {
  const runs = await loadRuns();
  const closed = await alreadyClosedRunIds();

  const candidates: Candidate[] = [];
  const excludedByList: string[] = [];
  for (const { run_id, data } of runs) {
    if (EXCLUDE_SUBSTRINGS.some((sub) => run_id.includes(sub))) {
      excludedByList.push(run_id);
      continue;
    }
    if (closed.has(run_id)) continue; // already has a closeout — nothing to do (idempotent).
    const cycle = typeof data.cycle === 'number' ? data.cycle : NaN;
    const stageCount = STAGE_COUNT_BY_CYCLE[cycle];
    if (stageCount === undefined) continue; // no stage-count (c7-reserved / no/invalid cycle) → skip.
    const distinctGo = distinctGoCount(data);
    if (distinctGo !== stageCount) continue; // did NOT reach final → genuinely not done, stays active.
    candidates.push({
      run_id,
      cycle,
      distinctGo,
      stageCount,
      credential_id: String(data.credential_id ?? ''),
    });
  }

  let written = 0;
  for (const c of candidates) {
    if (!execute) continue;
    const record = {
      activity_type: 'version_closeout',
      run_id: c.run_id,
      is_superseded: false,
      backfilled: true,
      provenance: {
        reason:
          'pre-R13 completed run lacking a native version_closeout (28c §12.1 finalization back-fill)',
        criterion: "COUNT(distinct GO'd stages) === stage_count_by_cycle[cycle] (index-safe)",
        stage_count_by_cycle: STAGE_COUNT_BY_CYCLE,
        cycle: c.cycle,
        distinct_go_stages: c.distinctGo,
        backfilled_by: 'openarx-core',
        contract: '§12.1 finalization-contract (Vlad material sign-off 2026-07-15)',
      },
      content: {
        text:
          `Back-filled closeout: this run completed all ${c.stageCount} stages (GO) of cycle ${c.cycle} ` +
          `before the version_closeout convention (R13) existed. Marked finalized so done-derivation ` +
          `reflects its true state. NOT a native methodist closure (see provenance.backfilled).`,
        status: 'complete',
      },
      attester_id: c.credential_id,
      id: `backfill-closeout:${c.run_id}`,
    };
    // Top-level scalars MATCH the native version_closeout shape (activity_type, run_id,
    // is_superseded, attester_id) so a top-level-run_id-keyed query/index sees back-filled
    // closeouts identically — the in-memory `_data.run_id` path already finds them, but graph
    // hygiene + latent-risk demand parity with native. `backfilled` scalar lets methodist
    // AAR/closure analytics filter synthetic closures cheaply.
    await neoPut('activity', 'id', record.id, record, {
      activity_type: 'version_closeout',
      attester_id: c.credential_id,
      run_id: c.run_id,
      is_superseded: false,
      backfilled: true,
    });
    written++;
  }

  const countMismatch = candidates.length !== EXPECTED_BACKFILL_COUNT;
  console.log(
    JSON.stringify(
      {
        stage: execute ? 'execute' : 'verify',
        totalRuns: runs.length,
        alreadyClosed: closed.size,
        excludedByList,
        candidateCount: candidates.length,
        expected: EXPECTED_BACKFILL_COUNT,
        countMismatch,
        candidates: candidates.map((c) => ({
          run_id: c.run_id,
          cycle: c.cycle,
          distinctGo: c.distinctGo,
          stageCount: c.stageCount,
        })),
        ...(execute ? { written } : {}),
      },
      null,
      2,
    ),
  );
  if (countMismatch) {
    console.log(
      `⚠ candidate count ${candidates.length} ≠ expected ${EXPECTED_BACKFILL_COUNT} — STOP and reconcile with the audit before execute.`,
    );
  }
  await closeNeo4j();
  process.exit(0);
}

/** Re-assert top-level scalars on ALREADY-written back-filled closeouts (idempotent MERGE by id;
 *  _data content unchanged) so their Neo4j property shape matches native version_closeout. Needed
 *  once for the initial 7 that were written with only {activity_type, attester_id} scalars. */
async function alignScalars(): Promise<void> {
  const acts = await neoListActivitiesByType('version_closeout');
  const backfilled = acts.filter((a) => a.backfilled === true);
  let aligned = 0;
  for (const a of backfilled) {
    const id = String(a.id ?? '');
    const runId = String(a.run_id ?? '');
    if (!id || !runId) continue;
    await neoPut('activity', 'id', id, a, {
      activity_type: 'version_closeout',
      attester_id: String(a.attester_id ?? ''),
      run_id: runId,
      is_superseded: false,
      backfilled: true,
    });
    aligned++;
  }
  console.log(JSON.stringify({ stage: 'align', backfilled: backfilled.length, aligned }, null, 2));
  await closeNeo4j();
  process.exit(0);
}

const stage = process.argv[2];
if (stage === 'verify') {
  void run(false).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else if (stage === 'execute') {
  void run(true).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else if (stage === 'align') {
  void alignScalars().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error('usage: mark-final-backfill.ts <verify|execute|align>');
  process.exit(1);
}
