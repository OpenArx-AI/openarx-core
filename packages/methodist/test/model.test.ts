import { describe, expect, it } from 'vitest';
import {
  invoke,
  modelPrimitives,
  Registry,
  RuntimeError,
  sha256Hex,
  type ModelResponse,
  type Outcome,
  type RuntimeDeps,
} from '../src/index.js';
import { InMemoryStores, RecordedModelClient } from '../src/testkit/index.js';

function reg(): Registry {
  const r = new Registry();
  r.registerAll(modelPrimitives());
  return r;
}
function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return { registry: reg(), stores: new InMemoryStores(), ...over };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}

// ── prepare-context (golden, byte-exact) ──────────────────────────────────────
describe('prepare-context', () => {
  it('substitutes {{tokens}} from named inputs; anchors on the static prefix', async () => {
    const prompt = 'You are a methodist.\n--- RUNTIME INPUTS ---\nintent: {{intent}}\ndossier: {{dossier_map}}';
    const out = await invoke(deps(), { id: 'prepare-context', version: 'v1', params: { prompt }, inputs: { intent: 'find X', dossier_map: { level: 3 } } });
    const res = ok(out) as { prepared_context: string; cache_anchor: string };
    expect(res.prepared_context).toBe('You are a methodist.\n--- RUNTIME INPUTS ---\nintent: find X\ndossier: {"level":3}');
    // cache anchor = sha256 of the STATIC prefix (before the runtime-inputs marker)
    expect(res.cache_anchor).toBe(sha256Hex('You are a methodist.\n'));
  });

  it('serializes object tokens with JCS (key order independent)', async () => {
    const mk = (d: unknown) => invoke(deps(), { id: 'prepare-context', version: 'v1', params: { prompt: '{{d}}' }, inputs: { d } });
    const a = ok(await mk({ b: 2, a: 1 })) as { prepared_context: string };
    const b = ok(await mk({ a: 1, b: 2 })) as { prepared_context: string };
    expect(a.prepared_context).toBe('{"a":1,"b":2}');
    expect(a.prepared_context).toBe(b.prepared_context);
  });
});

// ── call-model (recorded model; shape + branching, not judgment) ──────────────
describe('call-model', () => {
  const invokeCall = (model: RecordedModelClient) =>
    invoke(deps({ model }), { id: 'call-model', version: 'v1', params: { model: 'gemini' }, inputs: { context: 'ctx' } });

  it('parses the structured output', async () => {
    const out = await invokeCall(new RecordedModelClient([{ raw: '{"verdict":"VERIFIED","score":0.9}' } as ModelResponse]));
    expect(ok(out)).toEqual({ verdict: 'VERIFIED', score: 0.9 });
  });

  it('unparseable output → rejected (bad-output, not retried)', async () => {
    const model = new RecordedModelClient([{ raw: 'not json' } as ModelResponse]);
    const out = await invokeCall(model);
    expect(out.status).toBe('rejected');
    expect(model.calls).toBe(1); // contract fault, no retry
  });

  it('retries a technical fault then parses', async () => {
    const model = new RecordedModelClient([new RuntimeError('model-error', 'transient'), { raw: '{"ok":true}' } as ModelResponse]);
    const out = await invokeCall(model);
    expect(ok(out)).toEqual({ ok: true });
    expect(model.calls).toBe(2);
  });

  it('passes the cache anchor through to the model request', async () => {
    const model = new RecordedModelClient([{ raw: '{}' } as ModelResponse]);
    await invoke(deps({ model }), { id: 'call-model', version: 'v1', params: { model: 'gemini' }, inputs: { context: 'ctx', cache_anchor: 'ANCHOR1' } });
    expect(model.requests[0].cacheAnchor).toBe('ANCHOR1');
  });
});
