import { describe, expect, it } from 'vitest';
import {
  invoke,
  Registry,
  retrievalPrimitives,
  type Embed,
  type Outcome,
  type RuntimeDeps,
} from '../src/index.js';
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
const finalized = async (stores: InMemoryStores, run_id: string): Promise<boolean> =>
  (
    ok(
      await invoke(deps(stores), { id: 'fetch-run-closeout', version: 'v1', inputs: { run_id } }),
    ) as { finalized: boolean }
  ).finalized;

describe('fetch-run-closeout (§12.1 finalization presence)', () => {
  it('finalized=true when a non-superseded version_closeout exists for the run', async () => {
    const s = new InMemoryStores().seed('activities', 'a1', {
      activity_type: 'version_closeout',
      run_id: 'r1',
      is_superseded: false,
    });
    expect(await finalized(s, 'r1')).toBe(true);
  });

  it('finalized=true for a back-filled closeout — presence counts uniformly (flag is analytics-only)', async () => {
    const s = new InMemoryStores().seed('activities', 'a1', {
      activity_type: 'version_closeout',
      run_id: 'r1',
      is_superseded: false,
      backfilled: true,
    });
    expect(await finalized(s, 'r1')).toBe(true);
  });

  it('finalized=false when the run’s only closeout is superseded', async () => {
    const s = new InMemoryStores().seed('activities', 'a1', {
      activity_type: 'version_closeout',
      run_id: 'r1',
      is_superseded: true,
    });
    expect(await finalized(s, 'r1')).toBe(false);
  });

  it('finalized=false when the closeout belongs to a different run', async () => {
    const s = new InMemoryStores().seed('activities', 'a1', {
      activity_type: 'version_closeout',
      run_id: 'rOTHER',
      is_superseded: false,
    });
    expect(await finalized(s, 'r1')).toBe(false);
  });

  it('finalized=false when no closeout activities exist at all', async () => {
    expect(await finalized(new InMemoryStores(), 'r1')).toBe(false);
  });
});
