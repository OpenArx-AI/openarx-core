import { describe, expect, it } from 'vitest';
import { invoke, Registry, statePrimitives, type Embed, type Outcome, type RuntimeDeps } from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';

const stubEmbed: Embed = (text) => [text.length, 0, 0];
let mintN = 0;
const stubMint = (cred: string) => `run:${cred}:${++mintN}`;
const stubNow = () => '2026-07-08T00:00:00Z';
let aidN = 0;
const stubAssign = (_r: Record<string, unknown>, t: string, p: string) => `${p}:${t}:${++aidN}`;

// §12.7 vectorize is schema-driven: a type is embedded iff its record_schema declares a
// `vector` block. Minimal test schema — projection '{{text}}' keeps the embedded text == the
// claim text so stubEmbed([text.length,0,0]) stays predictable.
const testRecordSchemas = {
  claim: { vector: { projection: '{{text}}', payload: ['claim_status'], models: ['gemini'] } },
};
function reg(): Registry {
  const r = new Registry();
  r.registerAll(statePrimitives(stubEmbed, stubMint, stubNow, stubAssign, testRecordSchemas));
  return r;
}
function deps(r: Registry, stores: InMemoryStores): RuntimeDeps {
  return { registry: r, stores };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}
const call = (stores: InMemoryStores, id: string, body: Record<string, unknown>) =>
  invoke(deps(reg(), stores), { id, version: 'v1', ...body });

// ── create-run (mints run_id, keyed by credential) ────────────────────────────
describe('create-run', () => {
  it('mints a run_id and writes an active run node', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'create-run', { inputs: { credential_id: 'agent:a', methodology_version: 'v2' } });
    const runId = (ok(out) as { run_id: string }).run_id;
    expect(runId).toContain('agent:a');
    expect(stores.dump('run-state').kv.get(runId)).toMatchObject({ credential_id: 'agent:a', status: 'active', go_marks: [], parent_run_id: null });
  });
  it('rejects a dangling parent, writes nothing', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'create-run', { inputs: { credential_id: 'agent:a', parent_run_id: 'ghost' } });
    expect(out.status).toBe('rejected');
    expect(stores.dump('run-state').kv.size).toBe(0);
  });
});

// ── update-run-state (flat params, branch by data) ────────────────────────────
describe('update-run-state', () => {
  const seedRun = (over: Record<string, unknown> = {}) =>
    new InMemoryStores().seed('run-state', 'r1', { run_id: 'r1', current_stage: 1, go_marks: [], status: 'active', dose: {}, ...over });

  it('diagnose form: sets stage + cycle + dose', async () => {
    const stores = seedRun({ current_stage: null });
    // input cycle '3' (numeric string) → oyq §12.1 normalizes to canonical INTEGER 3 (run.cycle
    // is integer; §4.3-identity-critical). Pre-existing stale expectation ('3') fixed to match the
    // deployed oyq integer semantics (commit 21c4194) — see cycle-label.ts.
    await call(stores, 'update-run-state', { inputs: { run_id: 'r1', stage: 1, cycle: '3', dose: { stage: 1, operations: ['x'] } } });
    expect(stores.dump('run-state').kv.get('r1')).toMatchObject({ current_stage: 1, cycle: 3, dose: { stage: 1 } });
    expect(stores.dump('journal').log[0].entry).toMatchObject({ run_id: 'r1', event: 'dose_issued', payload: { stage: 1 } });
  });
  it('checkpoint GO: marks GO for the judged stage, advances, carries next_dose', async () => {
    const stores = seedRun();
    await call(stores, 'update-run-state', { inputs: { run_id: 'r1', verdict: { verdict: 'GO' }, next_dose: { stage: 2 } } });
    const n = stores.dump('run-state').kv.get('r1') as Record<string, unknown>;
    expect(n.go_marks).toEqual([1]);
    expect(n.current_stage).toBe(2);
    expect(n.dose).toEqual({ stage: 2 });
    // §12.1-bis: typed path-event emitted (stage = the JUDGED stage, before advance)
    expect(stores.dump('journal').log[0].entry).toMatchObject({ run_id: 'r1', event: 'checkpoint_go', payload: { stage: 1, verdict: 'GO' } });
  });
  it('checkpoint RETURN: no GO mark, stage unchanged; a forged payload.stage cannot move it', async () => {
    const stores = seedRun();
    // §12.1-bis anti-gaming: agent passes stage:99 on the checkpoint — the SERVER-tracked
    // stage must win (current_stage stays 1, checkpoint_return carries the real stage 1).
    await call(stores, 'update-run-state', { inputs: { run_id: 'r1', verdict: { verdict: 'RETURN' }, stage: 99 } });
    const n = stores.dump('run-state').kv.get('r1') as Record<string, unknown>;
    expect(n.go_marks).toEqual([]);
    expect(n.current_stage).toBe(1);
    expect(stores.dump('journal').log[0].entry).toMatchObject({ run_id: 'r1', event: 'checkpoint_return', payload: { stage: 1, verdict: 'RETURN' } });
  });
  it('report_need: pauses + records need', async () => {
    const stores = seedRun();
    await call(stores, 'update-run-state', { inputs: { run_id: 'r1', status: 'paused', need: 'more time' } });
    expect(stores.dump('run-state').kv.get('r1')).toMatchObject({ status: 'paused', need: 'more time' });
    expect(stores.dump('journal').log[0].entry).toMatchObject({ run_id: 'r1', event: 'report_need', payload: { need: 'more time' } });
  });
  it('missing run → rejected', async () => {
    const out = await call(new InMemoryStores(), 'update-run-state', { inputs: { run_id: 'ghost', status: 'done' } });
    expect(out.status).toBe('rejected');
  });

  // §12.1 Model U (t5rb): with the dose_by_cycle_stage table present, the dose is a WRITE-THROUGH
  // PROJECTION of the authoritative (cycle, current_stage) — re-derived on every write, overriding
  // any caller-passed dose, so it can never lag the stage. No table ⇒ legacy caller-set dose stands.
  const DOSE_TABLE = {
    c3: {
      '1': { operations: ['diagnose ops'], beacons: ['b1'], counters: ['ct1'], expected_artifacts: ['a1'] },
      '2': { operations: ['stage2 ops'], beacons: ['b2'], counters: ['ct2'], expected_artifacts: ['a2'] },
    },
  };
  it('Model U diagnose: dose is DERIVED from the table (overrides any passed LLM dose)', async () => {
    const stores = seedRun({ current_stage: null });
    await call(stores, 'update-run-state', {
      inputs: { run_id: 'r1', stage: 1, cycle: '3', dose: { stage: 1, operations: ['IGNORED LLM dose'] } },
      params: { dose_by_cycle_stage: DOSE_TABLE },
    });
    const n = stores.dump('run-state').kv.get('r1') as Record<string, unknown>;
    expect(n.cycle).toBe(3);
    expect(n.current_stage).toBe(1);
    expect(n.dose).toEqual({ operations: ['diagnose ops'], beacons: ['b1'], counters: ['ct1'], expected_artifacts: ['a1'], stage: 1 });
  });
  it('Model U checkpoint GO: next dose is re-derived for the ADVANCED stage (no lag), not the passed next_dose', async () => {
    const stores = seedRun({ cycle: 3, current_stage: 1 });
    await call(stores, 'update-run-state', {
      inputs: { run_id: 'r1', verdict: { verdict: 'GO' }, next_dose: { stage: 2, operations: ['IGNORED'] } },
      params: { dose_by_cycle_stage: DOSE_TABLE },
    });
    const n = stores.dump('run-state').kv.get('r1') as Record<string, unknown>;
    expect(n.current_stage).toBe(2);
    expect(n.dose).toEqual({ operations: ['stage2 ops'], beacons: ['b2'], counters: ['ct2'], expected_artifacts: ['a2'], stage: 2 });
  });
  it('Model U miss (GO past the last authored cell) clears the dose (done-view, no dose)', async () => {
    const stores = seedRun({ cycle: 3, current_stage: 2 });
    const out = await call(stores, 'update-run-state', {
      inputs: { run_id: 'r1', verdict: { verdict: 'GO' } },
      params: { dose_by_cycle_stage: DOSE_TABLE },
    });
    const n = stores.dump('run-state').kv.get('r1') as Record<string, unknown>;
    expect(n.current_stage).toBe(3);
    expect(n.dose).toBeNull();
    // done case: the RETURNED dose is null too → route.GO surfaces "no next dose" gracefully
    expect((out as { outputs: { dose: unknown } }).outputs.dose).toBeNull();
  });
  it('Model U: update-run-state RETURNS the materialized dose (route.GO reads $rstate.dose — no dangling $verdict.next_dose)', async () => {
    const stores = seedRun({ cycle: 3, current_stage: 1 });
    const out = await call(stores, 'update-run-state', {
      inputs: { run_id: 'r1', verdict: { verdict: 'GO' } },
      params: { dose_by_cycle_stage: DOSE_TABLE },
    });
    expect(out.status).toBe('ok');
    expect((out as { outputs: { dose: unknown } }).outputs.dose).toEqual({
      operations: ['stage2 ops'], beacons: ['b2'], counters: ['ct2'], expected_artifacts: ['a2'], stage: 2,
    });
  });
});

// ── update-dossier (verdict → delta, methodology-owned rules) ──────────────────
describe('update-dossier', () => {
  const d = (s: InMemoryStores) => s.dump('dossier').kv.get('agent:a') as Record<string, unknown>;

  it('autonomy ONLY from next_dose.autonomy.level — no mechanical GO-increment', async () => {
    const stores = new InMemoryStores();
    await call(stores, 'update-dossier', { inputs: { credential_id: 'agent:a', verdict: { verdict: 'GO' }, cycle: 'c3' } });
    expect(d(stores).autonomy_by_context).toEqual({}); // GO alone does NOT advance autonomy
    await call(stores, 'update-dossier', { inputs: { credential_id: 'agent:a', verdict: { verdict: 'GO', next_dose: { autonomy: { level: 'supervised' } } }, cycle: 'c3' } });
    expect(d(stores).autonomy_by_context).toEqual({ c3: 'supervised' });
  });
  it('tier on probe fire; passed_units on GO+unit; patches accumulate', async () => {
    const stores = new InMemoryStores();
    await call(stores, 'update-dossier', {
      inputs: { credential_id: 'agent:a', verdict: { verdict: 'GO', patches: [{ id: 'p1' }] }, tier_signal: { target_tier: 'L3' }, creative_element: 'triz', unit_id: 'u1', unit_level: 2 },
    });
    expect(d(stores).tier_by_context).toEqual({ triz: 'L3' });
    expect((d(stores).passed_units as unknown[])[0]).toMatchObject({ unit_id: 'u1', verdict: 'GO' });
    expect(d(stores).patches_received).toEqual([{ id: 'p1' }]);
  });
  it('corrections: RETURN appends not_yet; next GO marks applied_next_stage', async () => {
    const stores = new InMemoryStores();
    await call(stores, 'update-dossier', { inputs: { credential_id: 'agent:a', verdict: { verdict: 'RETURN', corrections: [{ what: 'fix X' }] } } });
    expect(d(stores).corrections).toEqual([{ topic: 'fix X', uptake: 'not_yet', date: '2026-07-08T00:00:00Z' }]);
    await call(stores, 'update-dossier', { inputs: { credential_id: 'agent:a', verdict: { verdict: 'GO' } } });
    expect((d(stores).corrections as Array<{ uptake: string }>)[0].uptake).toBe('applied_next_stage');
  });
});

// ── append-journal ────────────────────────────────────────────────────────────
describe('append-journal', () => {
  it('appends {event,payload} and returns its id', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'append-journal', { inputs: { run_id: 'r1', event: 'diagnose', payload: { x: 1 } } });
    expect((ok(out) as { entry_id: string }).entry_id).toBeTruthy();
    expect(stores.dump('journal').log[0].entry).toMatchObject({ run_id: 'r1', event: 'diagnose', payload: { x: 1 } });
  });
});

// ── create-corrective-activity (supersede scenario — dormant in live checkpoint) ─
describe('create-corrective-activity', () => {
  it('appends a corrective activity linked wasInformedBy to the superseded claim', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'create-corrective-activity', { inputs: { run_id: 'r1', target_ref: 'claim:X', reason: 'refinement' } });
    expect((ok(out) as { activity_id: string }).activity_id).toBeTruthy();
    expect(stores.dump('activities').log[0].entry).toMatchObject({ activity_type: 'corrective', target_ref: 'claim:X', wasInformedBy: ['claim:X'] });
  });
});

// ── write-graph-records (verdict-branch + outcome-activity) ───────────────────
describe('write-graph-records', () => {
  const base = { run_id: 'r1', credential_id: 'agent:a', cycle: '3', stage: 2, track_note: { intended: 'x', did: 'y', derived: 'z' } };
  it('GO: publishes annotated claims + a checkpoint_go outcome-activity', async () => {
    const out = await call(new InMemoryStores(), 'write-graph-records', {
      inputs: { ...base, verdict: { verdict: 'GO', quality: { dims: [] } }, verify_status: { outcome: 'VERIFIED' }, language: 'en', records: [{ record_type: 'claim', record: { content: { text: 'c', claim_status: 'empirical_result' } } }] },
    });
    const written = (ok(out) as { written: Array<{ record_type: string; record: Record<string, unknown> }> }).written;
    expect(written).toHaveLength(2);
    const claim = written.find((w) => w.record_type === 'claim')!;
    expect(claim.record.attester_id).toBe('agent:a'); // author = authenticated mentee (boundary-1)
    expect(claim.record.verification).toEqual({ outcome: 'VERIFIED' });
    expect(claim.record.language).toBe('en');
    // eied: schema indexed_properties denorm'd to top-level native scalars
    expect(claim.record.run_id).toBe('r1');
    expect(claim.record.is_superseded).toBe(false);
    expect(claim.record.claim_status).toBe('empirical_result'); // denorm'd from ClaimContent.claim_status
    const act = written.find((w) => w.record_type === 'activity')!.record;
    expect(act).toMatchObject({ activity_type: 'checkpoint_go', applied_instrument: 'methodist', generated: [claim.record.id], run_id: 'r1', is_superseded: false });
    expect((act.activity_content as Record<string, unknown>).track_note).toEqual(base.track_note);
    expect((act.activity_content as { cycle_context: Record<string, unknown> }).cycle_context).toMatchObject({ run_id: 'r1', cycle_type: '3', stage_id: 2 });
  });
  it('RETURN: writes ONLY a checkpoint_return activity, no claim', async () => {
    const out = await call(new InMemoryStores(), 'write-graph-records', {
      inputs: { ...base, verdict: { verdict: 'RETURN', reasons: ['weak'], corrections: [{ what: 'fix' }] }, records: [{ record_type: 'claim', record: { content: { text: 'c' } } }] },
    });
    const written = (ok(out) as { written: Array<{ record_type: string; record: Record<string, unknown> }> }).written;
    expect(written).toHaveLength(1);
    expect(written[0].record).toMatchObject({ activity_type: 'checkpoint_return', run_id: 'r1', is_superseded: false });
    expect((written[0].record.activity_content as Record<string, unknown>).reasons).toEqual(['weak']);
    expect(written.some((w) => w.record_type === 'claim')).toBe(false);
  });
});

// ── commit-bundle-atomic (in{written}, all-or-nothing) ────────────────────────
describe('commit-bundle-atomic', () => {
  it('atomically writes the staged set', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'commit-bundle-atomic', { inputs: { written: [{ record_type: 'claim', record: { id: 'c1', content: {} } }, { record_type: 'activity', record: { id: 'a1' } }] } });
    expect((ok(out) as { committed: unknown[] }).committed).toHaveLength(2);
    expect(stores.dump('graph').kv.size).toBe(2);
    expect(stores.dump('graph').kv.get('c1')).toMatchObject({ record_type: 'claim' });
  });
  it('a staged record missing id aborts the commit — nothing written', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'commit-bundle-atomic', { inputs: { written: [{ record_type: 'claim', record: { id: 'c1' } }, { record_type: 'activity', record: {} }] } });
    expect(out.status).toBe('rejected');
    expect(stores.dump('graph').kv.size).toBe(0);
  });
});

// ── vectorize-and-store (in{committed}, no-op on RETURN) ──────────────────────
describe('vectorize-and-store', () => {
  it('embeds + stores vectors for committed claims', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'vectorize-and-store', { inputs: { committed: [{ record_type: 'claim', record: { id: 'c1', content: { text: 'abcd' } } }, { record_type: 'activity', record: { id: 'a1' } }] } });
    expect((ok(out) as { vector_ids: string[] }).vector_ids).toEqual(['vec:c1']);
    expect(stores.dump('vector').kv.get('vec:c1')).toMatchObject({ ref: 'c1', vector: [4, 0, 0], namespace: 'layer2_claims' });
  });
  it('no-op when no claim committed (RETURN)', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'vectorize-and-store', { inputs: { committed: [{ record_type: 'activity', record: { id: 'a1' } }] } });
    expect(out.status).toBe('returned');
    expect(stores.dump('vector').kv.size).toBe(0);
  });
  it('renders the schema projection with computed {{run}}/{{edges}} + schema payload', async () => {
    const stores = new InMemoryStores();
    // Richer schema: projection references run-context + 1-hop edges + caveats; payload
    // picks two present-only fields. Exercises renderRunContext/renderEdges + embedPayload.
    const richSchemas = {
      claim: {
        vector: {
          projection: '[Context] {{run}} {{edges}}\n[Claim] {{text}} {{caveats}}',
          payload: ['claim_status', 'run_id'],
          models: ['gemini'],
        },
      },
    };
    const r = new Registry();
    r.registerAll(statePrimitives(stubEmbed, stubMint, stubNow, stubAssign, richSchemas));
    const committed = [
      { record_type: 'claim', record: { id: 'c1', run_id: 'run:x', claim_status: 'empirical_result', content: { text: 'A improves B', stated_scope_caveats: 'on dataset D' } } },
      { record_type: 'claim', record: { id: 'c2', content: { text: 'B is a metric' } } },
      { record_type: 'relation', record: { id: 'rel1', source_claim_id: 'c1', target_claim_id: 'c2', relation: 'support' } },
    ];
    const out = await invoke(deps(r, stores), { id: 'vectorize-and-store', version: 'v1', inputs: { committed } });
    expect((ok(out) as { vector_ids: string[] }).vector_ids).toEqual(['vec:c1', 'vec:c2']);
    const p = stores.dump('vector').kv.get('vec:c1') as { text: string; payload: Record<string, unknown> };
    expect(p.text).toContain('Run run:x'); // {{run}} computed
    expect(p.text).toContain('It supports: "B is a metric".'); // {{edges}} computed from the committed relation
    expect(p.text).toContain('A improves B on dataset D'); // {{text}} {{caveats}}
    expect(p.payload).toMatchObject({ claim_status: 'empirical_result', run_id: 'run:x' }); // schema payload, present-only
  });
});

// ── publish chain: wrapper-threaded I/O (regression) ─────────────────────────
// The methodology threads records through BARE slot refs ($resolved → $canon →
// $guarded → $written → $committed), so each publish primitive receives the PRIOR
// step's WRAPPER object, not a bare array. Guards the fix where GO iterated the
// wrapper directly ("not iterable" → internal). Each primitive accepts either form.
describe('publish chain — wrapper-threaded inputs', () => {
  it('write-graph-records GO accepts the $guarded wrapper {records:[...]}', async () => {
    const out = await call(new InMemoryStores(), 'write-graph-records', {
      inputs: {
        run_id: 'r1', credential_id: 'agent:a', cycle: '3', stage: 1,
        verdict: { verdict: 'GO', quality: { dims: [] } }, verify_status: { outcome: 'VERIFIED' },
        records: { allowed: true, records: [{ record_type: 'claim', record: { content: { text: 'c' } } }] },
      },
    });
    const written = (ok(out) as { written: Array<{ record_type: string; record: Record<string, unknown> }> }).written;
    expect(written).toHaveLength(2); // claim + checkpoint_go activity (not [] / not internal)
    expect(written.find((w) => w.record_type === 'claim')).toBeDefined();
  });
  it('commit-bundle-atomic accepts the $written wrapper {written:[...]}', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'commit-bundle-atomic', {
      inputs: { written: { written: [{ record_type: 'claim', record: { id: 'c1', content: {} } }, { record_type: 'activity', record: { id: 'a1' } }] } },
    });
    expect((ok(out) as { committed: unknown[] }).committed).toHaveLength(2);
    expect(stores.dump('graph').kv.size).toBe(2);
  });
  it('vectorize-and-store accepts the $committed wrapper {committed:[...]}', async () => {
    const stores = new InMemoryStores();
    const out = await call(stores, 'vectorize-and-store', {
      inputs: { committed: { committed: [{ record_type: 'claim', record: { id: 'c1', content: { text: 'abcd' } } }], bundle_id: 'bundle:1:c1' } },
    });
    expect((ok(out) as { vector_ids: string[] }).vector_ids).toEqual(['vec:c1']);
  });
});

// ── link-supersedes (unchanged — gated dedup path) ────────────────────────────
describe('link-supersedes', () => {
  it('allowed → writes edge + pointers; disallowed → returned, nothing written', async () => {
    const okStores = new InMemoryStores();
    const good = await call(okStores, 'link-supersedes', { params: { link_id: 'L1' }, inputs: { old_ref: 'O', new_ref: 'N', reason: 'refinement', guard_result: { allowed: true } } });
    expect(ok(good)).toEqual({ link_id: 'L1' });
    expect(okStores.dump('graph').kv.get('superseded_by:O')).toBe('N');

    const noStores = new InMemoryStores();
    const denied = await call(noStores, 'link-supersedes', { params: { link_id: 'L2' }, inputs: { old_ref: 'O', new_ref: 'N', reason: 'refinement', guard_result: { allowed: false } } });
    expect(denied.status).toBe('returned');
    expect(noStores.dump('graph').kv.size).toBe(0);
  });
});
