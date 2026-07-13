import { describe, expect, it } from 'vitest';
import { invoke, Registry, retrievalPrimitives, type Embed, type Outcome, type RuntimeDeps } from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';

const stubEmbed: Embed = () => [0];
function deps(stores: InMemoryStores): RuntimeDeps {
  const r = new Registry();
  r.registerAll(retrievalPrimitives(stubEmbed));
  return { registry: r, stores };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}

describe('fetch-run-path (§12.1-bis)', () => {
  function seeded(): InMemoryStores {
    return new InMemoryStores()
      .seed('journal', 'j1', { run_id: 'r1', event: 'dose_issued', payload: { stage: 1 }, created_at: '1' })
      .seed('journal', 'j2', { run_id: 'r1', event: 'checkpoint_go', payload: { stage: 1, verdict: 'GO' }, created_at: '2' })
      .seed('journal', 'j3', { run_id: 'r1', tool: 'search', created_at: '3' }) // tool-log — excluded
      .seed('journal', 'j4', { run_id: 'r1', event: 'report_need', payload: { need: 'x' }, created_at: '4' });
  }

  it('normalizes journal path-events (type/stage/ts) and excludes tool-log entries', async () => {
    const out = await invoke(deps(seeded()), { id: 'fetch-run-path', version: 'v1', inputs: { run_id: 'r1' } });
    const res = ok(out) as { path_events: Array<{ type: string; stage?: number; ts?: string }> };
    expect(res.path_events).toEqual([
      { type: 'dose_issued', stage: 1, ts: '1' },
      { type: 'checkpoint_go', stage: 1, ts: '2' },
      { type: 'report_need', stage: undefined, ts: '4' },
    ]);
  });

  it('empty path for a run with no journal entries', async () => {
    const out = await invoke(deps(new InMemoryStores()), { id: 'fetch-run-path', version: 'v1', inputs: { run_id: 'rX' } });
    expect((ok(out) as { path_events: unknown[] }).path_events).toEqual([]);
  });
});
