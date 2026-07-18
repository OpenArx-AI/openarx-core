import { describe, expect, it } from 'vitest';
import { definePrimitive, invoke as _invoke, Registry, runEndpoint, RuntimeError, type Methodology } from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';

// silence unused import (runtime invoke is exercised via runEndpoint)
void _invoke;

// ── mock primitives for the skeleton ──────────────────────────────────────────
function reg(): Registry {
  const r = new Registry();
  r.register(definePrimitive({ id: 'guard', version: 'v1', kind: 'algorithmic', goal: 't', access: [], effects: [], determinism: 'deterministic' }, ({ inputs }) => ({ outputs: { blocked: (inputs as { blocked?: unknown }).blocked === true } })));
  r.register(definePrimitive({ id: 'make-verdict', version: 'v1', kind: 'algorithmic', goal: 't', access: [], effects: [], determinism: 'deterministic' }, ({ params }) => ({ outputs: { verdict: (params as { v?: string }).v ?? 'GO', reasons: ['r1'] } })));
  r.register(definePrimitive({ id: 'persist', version: 'v1', kind: 'state', goal: 't', access: [], effects: ['journal'], determinism: 'deterministic' }, async ({ inputs, ctx }) => {
    await ctx.write('journal').append(inputs as Record<string, unknown>);
    return { outputs: { ok: true } };
  }));
  r.register(definePrimitive({ id: 'pick-route', version: 'v1', kind: 'algorithmic', goal: 't', access: [], effects: [], determinism: 'deterministic' }, ({ inputs }) => ({ outputs: { route: (inputs as { route?: unknown }).route } })));
  r.register(definePrimitive({ id: 'reject', version: 'v1', kind: 'algorithmic', goal: 't', access: [], effects: [], determinism: 'deterministic' }, () => {
    throw new RuntimeError('bad-output', 'schema_invalid: test reason');
  }));
  return r;
}

const methodology: Methodology = {
  methodology_version: 'skeleton',
  procedures: [
    {
      name: 'flow',
      trigger: { kind: 'endpoint', ref: 'flow' },
      steps: [
        { id: 'g', primitive: 'guard', version: 'v1', in: { blocked: '$input.blocked' }, out: 'g', gate: { when: { field: 'blocked', op: 'truthy' }, outcome: 'blocked' } },
        { id: 'v', primitive: 'make-verdict', version: 'v1', params: { v: 'GO' }, in: { note: '$input.note' }, out: 'v' },
        { id: 'p', primitive: 'persist', version: 'v1', in: { run_id: '$input.run_id', verdict: '$v.verdict' } },
      ],
      outcome_from: 'v',
      route: {
        GO: { ok: { const: true }, reasons: '$v.reasons', echoed: '$input.note' },
        RETURN: { ok: { const: false } },
        blocked: { blocked: { const: true } },
      },
    },
    {
      name: 'idemflow',
      trigger: { kind: 'endpoint', ref: 'idemflow' },
      steps: [
        { id: 'i', primitive: 'guard', version: 'v1', in: { blocked: '$input.seen' }, out: 'i', gate: { when: '$i.blocked', outcome: 'idempotent' } },
        { id: 'v', primitive: 'make-verdict', version: 'v1', params: { v: 'RETURN' }, out: 'v' },
      ],
      outcome_from: 'v',
      route: { GO: { done: { const: true } }, RETURN: { returned: { const: true } }, idempotent: { replayed: { const: true } } },
    },
    {
      name: 'entry',
      trigger: { kind: 'endpoint', ref: 'entry' },
      steps: [
        { id: 'r', primitive: 'pick-route', version: 'v1', in: { route: '$input.route' }, out: 'r', dispatch: { routes: { a: 'flow', b: 'idemflow' } } },
      ],
      route: {},
    },
    {
      // A step rejects; the procedure has NO 'error'/'rejected' route (mirrors the checkpoint door).
      name: 'rejflow',
      trigger: { kind: 'endpoint', ref: 'rejflow' },
      steps: [
        { id: 'rj', primitive: 'reject', version: 'v1', out: 'rj' },
        { id: 'v', primitive: 'make-verdict', version: 'v1', params: { v: 'GO' }, out: 'v' },
      ],
      outcome_from: 'v',
      route: { GO: { done: { const: true } } },
    },
  ],
};

function deps(stores = new InMemoryStores()) {
  return { runtime: { registry: reg(), stores }, methodology };
}

describe('interpreter', () => {
  it('runs linear steps, resolves slots, routes by outcome_from.verdict, persists unconditionally', async () => {
    const stores = new InMemoryStores();
    const res = await runEndpoint(deps(stores), 'flow', { blocked: false, note: 'hi', run_id: 'r1' });
    expect(res.outcome).toBe('GO');
    expect(res.response).toEqual({ ok: true, reasons: ['r1'], echoed: 'hi' });
    // persist ran (branch by data — unconditional)
    expect(stores.dump('journal').log[0].entry).toEqual({ run_id: 'r1', verdict: 'GO' });
  });

  it('stamps create-run with methodology_version from the config when the step does not bind it', async () => {
    // Regression: the diagnose wiring binds only credential_id/parent_run_id on create-run, so
    // the run node's methodology_version was always null (no per-version metrics). The interpreter
    // now threads the config version at run-birth (fill-only).
    const r = new Registry();
    let stamped: unknown = 'UNSET';
    r.register(
      definePrimitive(
        { id: 'create-run', version: 'v1', kind: 'state', goal: 't', access: [], effects: ['run-state'], determinism: 'deterministic' },
        ({ inputs }) => {
          stamped = (inputs as { methodology_version?: unknown }).methodology_version;
          return { outputs: { run_id: 'run:x', verdict: 'GO' } };
        },
      ),
    );
    const m: Methodology = {
      methodology_version: 'skeleton',
      procedures: [
        {
          name: 'birth',
          trigger: { kind: 'endpoint', ref: 'birth' },
          steps: [{ id: 'run', primitive: 'create-run', version: 'v1', in: { credential_id: '$input.agent_id' }, out: 'run' }],
          outcome_from: 'run',
          route: { GO: { run_id: '$run.run_id' } },
        },
      ],
    };
    await runEndpoint({ runtime: { registry: r, stores: new InMemoryStores() }, methodology: m }, 'birth', { agent_id: 'agent:a' });
    expect(stamped).toBe('skeleton'); // injected from config, not null
  });

  it('gate (condition form) short-circuits, skipping remaining steps', async () => {
    const stores = new InMemoryStores();
    const res = await runEndpoint(deps(stores), 'flow', { blocked: true, note: 'x', run_id: 'r1' });
    expect(res.outcome).toBe('blocked');
    expect(res.response).toEqual({ blocked: true });
    // make-verdict + persist were skipped
    expect(stores.dump('journal').log).toHaveLength(0);
  });

  it('gate (source-ref truthy form) short-circuits to idempotent', async () => {
    const res = await runEndpoint(deps(), 'idemflow', { seen: true });
    expect(res.outcome).toBe('idempotent');
    expect(res.response).toEqual({ replayed: true });
  });

  it('no gate hit → normal terminal route (RETURN)', async () => {
    const res = await runEndpoint(deps(), 'idemflow', { seen: false });
    expect(res.outcome).toBe('RETURN');
    expect(res.response).toEqual({ returned: true });
  });

  it('throws for an unbound endpoint', async () => {
    await expect(runEndpoint(deps(), 'nope', {})).rejects.toThrow(/no procedure/);
  });

  it('surfaces the reject reason (observability) — a bare {outcome:rejected} was blind', async () => {
    const res = await runEndpoint(deps(), 'rejflow', {});
    expect(res.outcome).toBe('rejected');
    const resp = res.response as Record<string, unknown>;
    expect(resp.reason).toBe('schema_invalid: test reason');
    expect(resp.reason_code).toBe('bad-output');
    expect(resp.rejected_at).toBe('rj');
  });
});

describe('dispatch (§3.1)', () => {
  it('routes to the mapped sub-procedure and returns its result', async () => {
    const res = await runEndpoint(deps(), 'entry', { route: 'a', blocked: false, note: 'hi', run_id: 'r1' });
    expect(res.outcome).toBe('GO');
    expect(res.response).toEqual({ ok: true, reasons: ['r1'], echoed: 'hi' });
  });

  it('runs the sub-procedure on a FRESH blackboard seeded with the original door input', async () => {
    const res = await runEndpoint(deps(), 'entry', { route: 'b', seen: true });
    expect(res.outcome).toBe('idempotent');
    expect(res.response).toEqual({ replayed: true });
  });

  it('falls back to identity (route name = procedure name) when unmapped', async () => {
    const res = await runEndpoint(deps(), 'entry', { route: 'flow', blocked: false, note: 'yo', run_id: 'r2' });
    expect(res.outcome).toBe('GO');
    expect(res.response).toEqual({ ok: true, reasons: ['r1'], echoed: 'yo' });
  });

  it('throws for a route with no procedure', async () => {
    await expect(runEndpoint(deps(), 'entry', { route: 'zzz' })).rejects.toThrow(/dispatch: no procedure/);
  });
});

// ── §12.1 state-batch integration (openarx-ntwe orphan-guard + t5rb derive-dose wiring) ──
import { deriveDosePrimitive } from '../src/primitives/algorithmic/derive-dose.js';

describe('interpreter — state-batch v1.9 wiring', () => {
  it('falsy gate on diag.cycle: empty diagnose → rejected, create-run SKIPPED (no orphan); valid → run created', async () => {
    let created = false;
    const r = new Registry();
    r.register(definePrimitive({ id: 'diag-mock', version: 'v1', kind: 'algorithmic', goal: 't', access: [], effects: [], determinism: 'deterministic' },
      ({ inputs }) => ({ outputs: ((inputs as { emit?: Record<string, unknown> }).emit ?? {}) })));
    r.register(definePrimitive({ id: 'mk-run', version: 'v1', kind: 'state', goal: 't', access: [], effects: [], determinism: 'deterministic' },
      () => { created = true; return { outputs: { run_id: 'r1' } }; }));
    const m: Methodology = {
      methodology_version: 't',
      procedures: [{
        name: 'dg', trigger: { kind: 'endpoint', ref: 'dg' },
        steps: [
          // real v1.9 shape: diag(+falsy gate) BEFORE create-run → a failed/empty diagnose aborts first
          { id: 'diag', primitive: 'diag-mock', version: 'v1', in: { emit: '$input.emit' }, out: 'diag', gate: { when: { field: 'cycle', op: 'falsy' }, outcome: 'rejected' } },
          { id: 'run', primitive: 'mk-run', version: 'v1', out: 'run' },
        ],
        route: { default: { ok: { const: true } }, rejected: { status: { const: 'diagnose_failed' } } },
      }],
    };
    const d = { runtime: { registry: r, stores: new InMemoryStores() }, methodology: m };
    const bad = await runEndpoint(d, 'dg', { emit: {} }); // no cycle → gate fires
    expect(bad.outcome).toBe('rejected');
    expect(created).toBe(false); // ★ create-run never ran → no orphan run
    created = false;
    const good = await runEndpoint(d, 'dg', { emit: { cycle: 3 } });
    expect(good.outcome).toBe('default');
    expect(created).toBe(true);
  });

  it('process_ref injects the _process dose table into a derive-dose step → dose looked up (t5rb)', async () => {
    const r = new Registry();
    r.register(deriveDosePrimitive); // the REAL primitive
    const m: Methodology = {
      methodology_version: 't',
      _process: { dose_by_cycle_stage: { c3: { '1': { operations: ['c3s1'], beacons: ['b'], counters: ['ct'], expected_artifacts: ['a'] } } } },
      procedures: [{
        name: 'dv', trigger: { kind: 'endpoint', ref: 'dv' },
        steps: [
          { id: 'derive', primitive: 'derive-dose', version: 'v1', params: { process_ref: 'dose_by_cycle_stage' }, in: { cycle: '$input.cycle', current_stage: { const: 1 } }, out: 'derive' },
        ],
        route: { default: { dose: '$derive.dose', found: '$derive.found' } },
      }],
    };
    const res = await runEndpoint({ runtime: { registry: r, stores: new InMemoryStores() }, methodology: m }, 'dv', { cycle: 3 });
    expect(res.response).toMatchObject({ found: true, dose: { operations: ['c3s1'], beacons: ['b'], counters: ['ct'], expected_artifacts: ['a'], stage: 1 } });
  });
});
