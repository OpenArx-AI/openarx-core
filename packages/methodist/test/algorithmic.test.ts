import { describe, expect, it } from 'vitest';
import {
  algorithmicPrimitives,
  invoke,
  Registry,
  type LangId,
  type Outcome,
  type RuntimeDeps,
} from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';

const stubLang: LangId = async (text) => (/[\u0430-\u044f]/i.test(text) ? { lang: 'ru', confidence: 0.99 } : { lang: 'en', confidence: 0.98 });

function reg(): Registry {
  const r = new Registry();
  r.registerAll(algorithmicPrimitives(stubLang));
  return r;
}
function deps(r: Registry, stores: InMemoryStores = new InMemoryStores()): RuntimeDeps {
  return { registry: r, stores };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}
const call = (r: Registry, id: string, body: Record<string, unknown>, stores?: InMemoryStores) =>
  invoke(deps(r, stores), { id, version: 'v1', ...body });

// ── check-stop-rule (§12.1-bis: pure — GO from checkpoint_go path-events) ──────
describe('check-stop-rule', () => {
  const goAt = (stage: number) => ({ type: 'checkpoint_go', stage });
  it('prev_not_go=false when the previous stage has a checkpoint_go; true + missing otherwise', async () => {
    const path_events = [goAt(1)];
    expect(ok(await call(reg(), 'check-stop-rule', { inputs: { path_events, stage: 2 } }))).toEqual({ prev_not_go: false });
    expect(ok(await call(reg(), 'check-stop-rule', { inputs: { path_events, stage: 3 } }))).toEqual({ prev_not_go: true, missing: 2 });
  });
  it('a checkpoint_return at prev does NOT count as GO', async () => {
    const path_events = [{ type: 'checkpoint_return', stage: 1 }];
    expect(ok(await call(reg(), 'check-stop-rule', { inputs: { path_events, stage: 2 } }))).toEqual({ prev_not_go: true, missing: 1 });
  });
  it('first stage (≤1) has no predecessor → passes', async () => {
    expect(ok(await call(reg(), 'check-stop-rule', { inputs: { path_events: [], stage: 1 } }))).toEqual({ prev_not_go: false });
  });
});

// ── check-idempotency (mock hash-index) ───────────────────────────────────────
describe('check-idempotency', () => {
  it('legacy string ref → GO outcome + prior, honouring scope', async () => {
    const stores = new InMemoryStores().seed('hash-index', 'sc:h1', 'prior-123');
    const seen = await call(reg(), 'check-idempotency', { inputs: { submission_hash: 'h1', scope: 'sc' } }, stores);
    expect(ok(seen)).toEqual({ hit: true, outcome: { verdict: 'GO', ref: 'prior-123' }, prior: 'prior-123' });
    const fresh = await call(reg(), 'check-idempotency', { inputs: { submission_hash: 'h2', scope: 'sc' } }, stores);
    expect(ok(fresh)).toEqual({ hit: false });
  });
  it('2g: key includes stage; returns the stored RETURN outcome for replay', async () => {
    const ret = { verdict: 'RETURN', reasons: ['weak'], corrections: [{ what: 'x' }] };
    const stores = new InMemoryStores().seed('hash-index', 'run1:2:h9', ret);
    const hit = await call(reg(), 'check-idempotency', { inputs: { run_id: 'run1', stage: 2, submission_hash: 'h9' } }, stores);
    expect(ok(hit)).toEqual({ hit: true, outcome: ret }); // RETURN has no ref → no prior
    // same hash, DIFFERENT stage → miss (stage is part of the key → the refinement cycle lives)
    const otherStage = await call(reg(), 'check-idempotency', { inputs: { run_id: 'run1', stage: 3, submission_hash: 'h9' } }, stores);
    expect(ok(otherStage)).toEqual({ hit: false });
  });
});

// ── validate-schema (pure) ────────────────────────────────────────────────────
describe('validate-schema', () => {
  const base = { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'number' } } };
  it('valid record → no errors', async () => {
    const out = await call(reg(), 'validate-schema', { params: { base_schema: base }, inputs: { record: { name: 'x', age: 3 } } });
    expect(ok(out)).toEqual({ valid: true, errors: [] });
  });
  it('missing required + type mismatch → errors by path', async () => {
    const out = await call(reg(), 'validate-schema', { params: { base_schema: base }, inputs: { record: { age: 'nope' } } });
    const res = ok(out) as { valid: boolean; errors: string[] };
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('$.name: required');
    expect(res.errors.some((e) => e.startsWith('age:'))).toBe(true);
  });
  it('overlay adds a required field (base ⊕ cycle overlay)', async () => {
    const overlay = { required: ['cycle'], properties: { cycle: { type: 'string' } } };
    const out = await call(reg(), 'validate-schema', { params: { base_schema: base, overlay }, inputs: { record: { name: 'x' } } });
    expect((ok(out) as { errors: string[] }).errors).toContain('$.cycle: required');
  });
});

// ── validate-schema fail-closed enforcement (openarx-xpfz) ─────────────────────
// When the platform per-type shape validator is INJECTED, a malformed record THROWS
// bad-output (rejected) instead of returning a silently-ignored { valid:false }.
describe('validate-schema fail-closed enforcement (§12.8)', () => {
  // stub platform validator mirroring validateRecordShape: a claim must be content-wrapped.
  const validateShape = (record: unknown, type: string): string[] => {
    if (type !== 'claim') return [];
    const c = (record as { content?: unknown })?.content;
    return c && typeof c === 'object' ? [] : ['content: required object (claim payload must be content-wrapped, not flat)'];
  };
  const regV = (): Registry => {
    const r = new Registry();
    r.registerAll(algorithmicPrimitives(stubLang, validateShape));
    return r;
  };
  const runV = (records: unknown) => call(regV(), 'validate-schema', { params: {}, inputs: { records } });

  it('throws (rejected) on a flat, non-content-wrapped claim', async () => {
    const out = await runV([{ record_type: 'claim', record: { type: 'Safety', statement: 'x' } }]);
    expect(out.status).toBe('rejected');
  });
  it('passes content-wrapped claims', async () => {
    const out = await runV([{ record_type: 'claim', record: { content: { text: 'a' } } }]);
    expect(ok(out)).toEqual({ valid: true, errors: [] });
  });
  it('does not gate a non-claim record by the claim shape', async () => {
    const out = await runV([{ record_type: 'relation', record: { source_claim_id: 'a', target_claim_id: 'b', relation: 'support' } }]);
    expect(ok(out)).toEqual({ valid: true, errors: [] });
  });
  it('accepts the {records_resolved} wrapper shape (resolve-local-ids output)', async () => {
    const out = await runV({ records_resolved: [{ record_type: 'claim', record: { content: { text: 'a' } } }], id_map: {} });
    expect(ok(out)).toEqual({ valid: true, errors: [] });
  });
});

// ── detect-language (injected lang-id) ────────────────────────────────────────
describe('detect-language', () => {
  it('routes text through the injected lang-id and flags confident non-English', async () => {
    expect(ok(await call(reg(), 'detect-language', { inputs: { text: '\u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440' } }))).toEqual({ lang: 'ru', confidence: 0.99, non_english: true, non_english_lang: 'ru' });
    expect(ok(await call(reg(), 'detect-language', { inputs: { text: 'hello world' } }))).toEqual({ lang: 'en', confidence: 0.98, non_english: false });
  });
});

// ── crosscheck-tool-usage (mock journal) ──────────────────────────────────────
describe('crosscheck-tool-usage', () => {
  it('flags claimed-not-logged and logged-not-claimed, scoped by run_id', async () => {
    const stores = new InMemoryStores();
    const log = stores.dump('journal').log;
    log.push({ id: 'e1', entry: { run_id: 'run1', tool: 'search' } });
    log.push({ id: 'e2', entry: { run_id: 'run1', tool: 'read' } });
    log.push({ id: 'e3', entry: { run_id: 'other', tool: 'write' } }); // different run → ignored

    const out = await call(reg(), 'crosscheck-tool-usage', { inputs: { claimed_usage: ['search', 'publish'], run_id: 'run1' } }, stores);
    const res = ok(out) as { consistent: boolean; discrepancies: string[] };
    expect(res.consistent).toBe(false);
    expect(res.discrepancies).toEqual(['claimed_not_logged:publish', 'logged_not_claimed:read']);
  });

  it('consistent when claimed matches the log exactly', async () => {
    const stores = new InMemoryStores();
    stores.dump('journal').log.push({ id: 'e1', entry: { run_id: 'run1', tool: 'search' } });
    const out = await call(reg(), 'crosscheck-tool-usage', { inputs: { claimed_usage: ['search'], run_id: 'run1' } }, stores);
    expect(ok(out)).toEqual({ consistent: true, discrepancies: [] });
  });
});

// ── classify-convergence (pure) ───────────────────────────────────────────────
describe('classify-convergence', () => {
  it('same run_id → erratum, different → convergent', async () => {
    expect(ok(await call(reg(), 'classify-convergence', { inputs: { record_a: { run_id: 'r1' }, record_b: { run_id: 'r1' } } }))).toEqual({ class: 'erratum' });
    expect(ok(await call(reg(), 'classify-convergence', { inputs: { record_a: { run_id: 'r1' }, record_b: { run_id: 'r2' } } }))).toEqual({ class: 'convergent' });
  });
});

// ── threshold-zone (boundaries) ───────────────────────────────────────────────
describe('threshold-zone', () => {
  const thresholds = { auto_min: 0.8, review_min: 0.5 };
  it('maps scores at and around the boundaries', async () => {
    const zone = async (score: number) => (ok(await call(reg(), 'threshold-zone', { params: { thresholds }, inputs: { score } })) as { zone: string }).zone;
    expect(await zone(0.8)).toBe('auto');
    expect(await zone(0.79)).toBe('review');
    expect(await zone(0.5)).toBe('review');
    expect(await zone(0.49)).toBe('reject');
  });
});

// ── select-canonical (priority ladder) ────────────────────────────────────────
describe('select-canonical', () => {
  const pick = async (cluster: unknown) => (ok(await call(reg(), 'select-canonical', { inputs: { cluster } })) as { canonical_id: string }).canonical_id;
  it('verified > convergent > has-evidence > earliest', async () => {
    expect(await pick([
      { id: 'a', convergent: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', verified: true, created_at: '2026-02-01T00:00:00Z' },
    ])).toBe('b'); // verified wins despite being later
    expect(await pick([
      { id: 'a', has_evidence: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', convergent: true, created_at: '2026-02-01T00:00:00Z' },
    ])).toBe('b'); // convergent > has-evidence
    expect(await pick([
      { id: 'a', created_at: '2026-03-01T00:00:00Z' },
      { id: 'b', created_at: '2026-01-01T00:00:00Z' },
    ])).toBe('b'); // earliest breaks the tie
  });
});

// ── apply-supersede-guards (each violation) ───────────────────────────────────
describe('apply-supersede-guards', () => {
  const base = { old_ref: 'O', new_ref: 'N', owner: 'agent:a', old_owner: 'agent:a', old_type: 'claim', new_type: 'claim', existing_links: [] as Array<{ from: string; to: string }> };
  const run = (over: Record<string, unknown>) => call(reg(), 'apply-supersede-guards', { inputs: { ...base, ...over } });

  it('clean supersede → allowed', async () => {
    expect(ok(await run({}))).toEqual({ allowed: true });
  });
  it('set-once: old already superseded → violated', async () => {
    const res = ok(await run({ existing_links: [{ from: 'X', to: 'O' }] })) as { allowed: boolean; violated: string[] };
    expect(res.allowed).toBe(false);
    expect(res.violated).toContain('set-once');
  });
  it('cycle: old already supersedes new → violated', async () => {
    const res = ok(await run({ existing_links: [{ from: 'O', to: 'N' }] })) as { violated: string[] };
    expect(res.violated).toContain('cycle');
  });
  it('ownership + type violations combine', async () => {
    const res = ok(await run({ old_owner: 'agent:b', new_type: 'metric' })) as { violated: string[] };
    expect(res.violated).toEqual(expect.arrayContaining(['ownership', 'type']));
  });
});

// ── compute-superseded-by (pure) ──────────────────────────────────────────────
describe('compute-superseded-by', () => {
  it('marks old→new and sets latest=new', async () => {
    expect(ok(await call(reg(), 'compute-superseded-by', { inputs: { old_ref: 'O', new_ref: 'N' } }))).toEqual({
      superseded_by: { O: 'N' },
      latest: 'N',
    });
  });
});

// ── filter-latest-only (pure) ─────────────────────────────────────────────────
describe('filter-latest-only', () => {
  it('drops superseded records, keeps the current ones', async () => {
    const out = await call(reg(), 'filter-latest-only', {
      inputs: { records: [{ id: 'a' }, { id: 'b', superseded_by: 'c' }, { id: 'c', superseded_by: null }] },
    });
    expect((ok(out) as { records_latest: Array<{ id: string }> }).records_latest.map((r) => r.id)).toEqual(['a', 'c']);
  });
});

// ── derive-dose (§12.1 t5rb: deterministic (cycle,stage) dose lookup) ──────────
describe('derive-dose', () => {
  const TABLE = {
    _meta: { purpose: 'test' },
    c3: {
      '1': { operations: ['op1'], beacons: ['b1'], counters: ['ct1'], expected_artifacts: ['a1'] },
      '5': {
        operations: ['synthesize top-N by reference'],
        beacons: ['bundle references existing claim_ids'],
        counters: ['do NOT re-mint committed claims'],
        expected_artifacts: ['narrative_synthesis bundle'],
      },
    },
    c1: { '1': { operations: ['sweep literature'], beacons: [], counters: [], expected_artifacts: [] } },
  };
  const derive = async (cycle: unknown, current_stage: unknown) =>
    ok(await call(reg(), 'derive-dose', { inputs: { cycle, current_stage }, params: { dose_by_cycle_stage: TABLE } })) as {
      found: boolean;
      dose?: Record<string, unknown>;
    };

  it('looks up (cycle,current_stage) → full field-set + stage (c3-St5 = the bundle fix cell)', async () => {
    const out = await derive(3, 5);
    expect(out.found).toBe(true);
    expect(out.dose).toEqual({
      operations: ['synthesize top-N by reference'],
      beacons: ['bundle references existing claim_ids'],
      counters: ['do NOT re-mint committed claims'],
      expected_artifacts: ['narrative_synthesis bundle'],
      stage: 5,
    });
  });

  it('accepts numeric-string cycle/stage (as stored on the run node)', async () => {
    expect((await derive('3', '1')).found).toBe(true);
  });

  it('c1 keyed by current_stage 1-7 (the +1 offset is in the table keys, not the primitive)', async () => {
    const out = await derive(1, 1);
    expect(out.found).toBe(true);
    expect(out.dose?.stage).toBe(1);
  });

  it('miss → found:false (out-of-range stage / reserved cycle 7 / unknown cycle) = fallback', async () => {
    expect((await derive(3, 99)).found).toBe(false);
    expect((await derive(7, 1)).found).toBe(false);
    expect((await derive(99, 1)).found).toBe(false);
  });

  it('no table → found:false (fallback to current generation)', async () => {
    const out = ok(await call(reg(), 'derive-dose', { inputs: { cycle: 3, current_stage: 5 } })) as { found: boolean };
    expect(out.found).toBe(false);
  });

  it('non-numeric cycle/stage → found:false (never keys on garbage)', async () => {
    expect((await derive('abc', 5)).found).toBe(false);
    expect((await derive(3, null)).found).toBe(false);
  });
});
