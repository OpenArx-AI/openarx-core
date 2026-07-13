import { describe, expect, it } from 'vitest';
import {
  CollectingObserver,
  definePrimitive,
  invoke,
  Registry,
  RuntimeError,
  type ModelClient,
  type ModelResponse,
  type Passport,
  type RuntimeDeps,
} from '../src/index.js';
import { InMemoryStores, RecordedModelClient } from '../src/testkit/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function deps(reg: Registry, over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return { registry: reg, stores: new InMemoryStores(), observer: new CollectingObserver(), ...over };
}
const p = (over: Partial<Passport> & Pick<Passport, 'id' | 'kind'>): Passport => ({
  version: 'v1',
  goal: 'test',
  access: [],
  effects: [],
  determinism: 'deterministic',
  ...over,
});

// ── registry (§1) ─────────────────────────────────────────────────────────────
describe('registry', () => {
  it('resolves exact version; unknown id/version → rejected', async () => {
    const reg = new Registry();
    reg.register(definePrimitive(p({ id: 'echo', kind: 'transform' }), ({ inputs }) => ({ outputs: inputs })));

    expect(reg.has('echo', 'v1')).toBe(true);
    const unknownId = await invoke(deps(reg), { id: 'nope', version: 'v1' });
    expect(unknownId.status).toBe('rejected');
    const unknownVer = await invoke(deps(reg), { id: 'echo', version: 'v2' });
    expect(unknownVer.status).toBe('rejected');
  });

  it('rejects duplicate registration', () => {
    const reg = new Registry();
    const reg1 = definePrimitive(p({ id: 'dup', kind: 'transform' }), () => ({ outputs: null }));
    reg.register(reg1);
    expect(() => reg.register(reg1)).toThrow(RuntimeError);
  });
});

// ── outcome taxonomy (§6) ─────────────────────────────────────────────────────
describe('outcome taxonomy', () => {
  it('ok carries outputs; returned is a valid business "no"', async () => {
    const reg = new Registry();
    reg.register(definePrimitive(p({ id: 'echo', kind: 'transform' }), ({ inputs }) => ({ outputs: inputs })));
    reg.register(
      definePrimitive(p({ id: 'stop', kind: 'algorithmic' }), () => ({ control: 'returned', outputs: { missing: 'GO' } })),
    );

    const ok = await invoke(deps(reg), { id: 'echo', version: 'v1', inputs: { a: 1 } });
    expect(ok).toEqual({ status: 'ok', outputs: { a: 1 } });

    const returned = await invoke(deps(reg), { id: 'stop', version: 'v1' });
    expect(returned.status).toBe('returned');
    expect(returned).toMatchObject({ outputs: { missing: 'GO' } });
  });

  it('a thrown technical error → failed', async () => {
    const reg = new Registry();
    reg.register(
      definePrimitive(p({ id: 'boom', kind: 'algorithmic' }), () => {
        throw new Error('kaboom');
      }),
    );
    const out = await invoke(deps(reg), { id: 'boom', version: 'v1' });
    expect(out.status).toBe('failed');
  });
});

// ── access enforcement (§4) ───────────────────────────────────────────────────
describe('access enforcement', () => {
  it('reading an undeclared store → rejected (access-violation)', async () => {
    const reg = new Registry();
    reg.register(
      definePrimitive(p({ id: 'peek', kind: 'transform', access: [] }), ({ ctx }) => {
        ctx.read('graph').get('x'); // not declared
        return { outputs: null };
      }),
    );
    const out = await invoke(deps(reg), { id: 'peek', version: 'v1' });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.error.code).toBe('access-violation');
  });

  it('declared read returns seeded data', async () => {
    const reg = new Registry();
    reg.register(
      definePrimitive(p({ id: 'rd', kind: 'retrieval', access: ['run-state'] }), async ({ ctx }) => ({
        outputs: await ctx.read('run-state').get('r1'),
      })),
    );
    const stores = new InMemoryStores().seed('run-state', 'r1', { stage: 3, go: true });
    const out = await invoke(deps(reg, { stores }), { id: 'rd', version: 'v1' });
    expect(out).toEqual({ status: 'ok', outputs: { stage: 3, go: true } });
  });

  it('writing an undeclared store → rejected (access-violation)', async () => {
    const reg = new Registry();
    reg.register(
      definePrimitive(p({ id: 'badwr', kind: 'state', effects: [] }), ({ ctx }) => {
        ctx.write('journal'); // not declared
        return { outputs: null };
      }),
    );
    const out = await invoke(deps(reg), { id: 'badwr', version: 'v1' });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.error.code).toBe('access-violation');
  });
});

// ── append-only enforcement (§5) ──────────────────────────────────────────────
describe('append-only stores', () => {
  it('append works; mutation of an append-only handle → rejected (immutable-store)', async () => {
    const reg = new Registry();
    reg.register(
      definePrimitive(p({ id: 'jappend', kind: 'state', effects: ['journal'] }), async ({ ctx }) => ({
        outputs: await ctx.write('journal').append({ msg: 'hi' }),
      })),
    );
    reg.register(
      definePrimitive(p({ id: 'jmutate', kind: 'state', effects: ['journal'] }), ({ ctx }) => {
        (ctx.write('journal') as unknown as { put: (k: string, v: unknown) => void }).put('x', 1);
        return { outputs: null };
      }),
    );

    const stores = new InMemoryStores();
    const ok = await invoke(deps(reg, { stores }), { id: 'jappend', version: 'v1' });
    expect(ok.status).toBe('ok');
    expect(stores.dump('journal').log).toHaveLength(1);

    const bad = await invoke(deps(reg, { stores }), { id: 'jmutate', version: 'v1' });
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') expect(bad.error.code).toBe('immutable-store');
  });
});

// ── model-call policy (§2) ────────────────────────────────────────────────────
describe('model-call', () => {
  const modelEcho = definePrimitive(p({ id: 'mecho', kind: 'model-call', determinism: 'model-dependent' }), async ({ model }) => {
    const r = await model!.generate({ context: 'ctx', modelId: 'gemini' });
    return { outputs: JSON.parse(r.raw) };
  });

  it('missing injected client → failed', async () => {
    const reg = new Registry();
    reg.register(modelEcho);
    const out = await invoke(deps(reg), { id: 'mecho', version: 'v1' }); // no model in deps
    expect(out.status).toBe('failed');
  });

  it('retries a technical fault, then succeeds (attempts=2)', async () => {
    const reg = new Registry();
    reg.register(modelEcho);
    const model = new RecordedModelClient([
      new RuntimeError('model-error', 'transient'),
      { raw: '{"ok":true}' } as ModelResponse,
    ]);
    const observer = new CollectingObserver();
    const out = await invoke(deps(reg, { model, observer }), { id: 'mecho', version: 'v1' });
    expect(out).toEqual({ status: 'ok', outputs: { ok: true } });
    expect(model.calls).toBe(2);
    expect(observer.records[0]).toMatchObject({ status: 'ok', attempts: 2, kind: 'model-call' });
  });

  it('times out a hanging model call → failed', async () => {
    const reg = new Registry();
    reg.register(modelEcho);
    const hang: ModelClient = { generate: () => new Promise<ModelResponse>(() => {}) };
    const out = await invoke(deps(reg, { model: hang, modelPolicy: { attempts: 1, timeoutMs: 20 } }), {
      id: 'mecho',
      version: 'v1',
    });
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.error.code).toBe('timeout');
  });
});

// ── observability (§8) ────────────────────────────────────────────────────────
describe('observability', () => {
  it('emits one record per invocation with status + params hash', async () => {
    const reg = new Registry();
    reg.register(definePrimitive(p({ id: 'echo', kind: 'transform' }), ({ inputs }) => ({ outputs: inputs })));
    const observer = new CollectingObserver();
    await invoke(deps(reg, { observer }), { id: 'echo', version: 'v1', params: { t: 1 }, inputs: 5 });
    expect(observer.records).toHaveLength(1);
    expect(observer.records[0]).toMatchObject({ id: 'echo', version: 'v1', status: 'ok' });
    expect(observer.records[0].paramsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
