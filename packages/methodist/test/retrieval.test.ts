import { describe, expect, it } from 'vitest';
import { invoke, Registry, retrievalPrimitives, type Embed, type Outcome, type RuntimeDeps } from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';

// stub embedder: maps a couple of known texts to fixed vectors (real path: gemini)
const stubEmbed: Embed = (text) => (text === 'cats' ? [1, 0, 0] : [0, 1, 0]);

function reg(): Registry {
  const r = new Registry();
  r.registerAll(retrievalPrimitives(stubEmbed));
  return r;
}
function deps(r: Registry, stores: InMemoryStores): RuntimeDeps {
  return { registry: r, stores };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}

// ── search-semantic (fixed index) ─────────────────────────────────────────────
describe('search-semantic', () => {
  function seeded(): InMemoryStores {
    return new InMemoryStores()
      .seed('vector', 'p1', { id: 'p1', vector: [1, 0, 0], topic: 'a' })
      .seed('vector', 'p2', { id: 'p2', vector: [0.9, 0.1, 0], topic: 'a' })
      .seed('vector', 'p3', { id: 'p3', vector: [0, 1, 0], topic: 'b' });
  }

  it('ranks by cosine and honours top-k (query_vector path)', async () => {
    const out = await invoke(deps(reg(), seeded()), {
      id: 'search-semantic',
      version: 'v1',
      inputs: { query_vector: [1, 0, 0], k: 2 },
    });
    const res = ok(out) as { candidates: Array<{ id: string; score: number }> };
    expect(res.candidates.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(res.candidates[0].score).toBeCloseTo(1, 6);
  });

  it('applies filters and embeds query_text via the injected embedder', async () => {
    const out = await invoke(deps(reg(), seeded()), {
      id: 'search-semantic',
      version: 'v1',
      inputs: { query_text: 'cats', filters: { topic: 'a' }, k: 5 },
    });
    const res = ok(out) as { candidates: Array<{ id: string }> };
    expect(res.candidates.map((c) => c.id)).toEqual(['p1', 'p2']); // p3 filtered out (topic b)
  });

  it('rejects when neither vector nor text is given', async () => {
    const out = await invoke(deps(reg(), seeded()), { id: 'search-semantic', version: 'v1', inputs: { k: 1 } });
    expect(out.status).toBe('rejected');
  });
});

// ── search-shared-source ──────────────────────────────────────────────────────
describe('search-shared-source', () => {
  const stores = () =>
    new InMemoryStores().seed('source-index', 'arxiv:1', [
      { id: 'c1', fragment: 'we observe a gain' },
      { id: 'c2', fragment: 'unrelated span' },
    ]);

  it('returns all records for the source when no fragment given', async () => {
    const out = await invoke(deps(reg(), stores()), {
      id: 'search-shared-source',
      version: 'v1',
      inputs: { source_uri: 'arxiv:1' },
    });
    expect((ok(out) as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('filters by fragment overlap', async () => {
    const out = await invoke(deps(reg(), stores()), {
      id: 'search-shared-source',
      version: 'v1',
      inputs: { source_uri: 'arxiv:1', fragment: 'we observe a gain here' },
    });
    const res = ok(out) as { candidates: Array<{ id: string }> };
    expect(res.candidates.map((c) => c.id)).toEqual(['c1']);
  });
});

// ── read-graph (projection + non-distribution policy) ─────────────────────────
describe('read-graph', () => {
  const stores = () =>
    new InMemoryStores()
      .seed('graph', 'r1', { id: 'r1', excerpt: 'public text', source_uri: 'arxiv:1', distributable: true, other: 'z' })
      .seed('graph', 'r2', { id: 'r2', excerpt: 'restricted verbatim', source_uri: 'arxiv:2', distributable: false });

  it('projects requested fields', async () => {
    const out = await invoke(deps(reg(), stores()), {
      id: 'read-graph',
      version: 'v1',
      inputs: { query: { ids: ['r1'] }, projection: { fields: ['excerpt'] } },
    });
    expect((ok(out) as { graph_view: unknown[] }).graph_view[0]).toEqual({ id: 'r1', excerpt: 'public text' });
  });

  it('never leaks a non-distributable verbatim excerpt — returns a pointer', async () => {
    const out = await invoke(deps(reg(), stores()), {
      id: 'read-graph',
      version: 'v1',
      inputs: { query: { ids: ['r2'] }, projection: { fields: ['excerpt'] } },
    });
    const view = (ok(out) as { graph_view: Array<{ id: string; excerpt: unknown }> }).graph_view[0];
    expect(view.excerpt).toEqual({ pointer: 'arxiv:2' });
    expect(JSON.stringify(view)).not.toContain('restricted verbatim');
  });

  it('§12.5-bis: strips a denormed run_id (top-level + nested) — never agent-facing', async () => {
    const s = new InMemoryStores().seed('graph', 'c1', {
      id: 'c1', record_type: 'claim', run_id: 'run:cred:uuid', text: 'a claim',
      cycle_context: { run_id: 'run:cred:uuid', cycle_type: 'c3' },
    });
    const out = await invoke(deps(reg(), s), { id: 'read-graph', version: 'v1', inputs: { query: { ids: ['c1'] }, projection: { fields: ['run_id', 'text', 'cycle_context'] } } });
    const view = (ok(out) as { graph_view: Array<Record<string, unknown>> }).graph_view[0];
    expect(view.run_id).toBeUndefined(); // top-level process id stripped
    expect(view.text).toBe('a claim');
    expect(view.cycle_context).toEqual({ cycle_type: 'c3' }); // nested run_id stripped, cycle_type kept
    expect(JSON.stringify(view)).not.toContain('run:cred:uuid');
  });

  it('§12.7: applies the per-type read schema strip_fields (track_note)', async () => {
    const r = new Registry();
    r.registerAll(retrievalPrimitives(stubEmbed, { claim: { read: { strip_fields: ['track_note'] } } }));
    const s = new InMemoryStores().seed('graph', 'c2', { id: 'c2', record_type: 'claim', text: 't', track_note: 'internal-journal' });
    const out = await invoke({ registry: r, stores: s }, { id: 'read-graph', version: 'v1', inputs: { query: { ids: ['c2'] }, projection: { fields: ['text', 'track_note'] } } });
    const view = (ok(out) as { graph_view: Array<Record<string, unknown>> }).graph_view[0];
    expect(view.text).toBe('t');
    expect(view.track_note).toBeUndefined(); // schema strip_fields
  });
});

// ── fetch-dossier / fetch-run-state (present → ok, absent → returned) ──────────
describe('fetch-dossier & fetch-run-state', () => {
  it('fetch-dossier: present → {credential_id, map}, absent → returned', async () => {
    const stores = new InMemoryStores().seed('dossier', 'agent:a', { autonomy_by_context: { c3: 'supervised' } });
    const present = await invoke(deps(reg(), stores), { id: 'fetch-dossier', version: 'v1', inputs: { credential_id: 'agent:a' } });
    expect(ok(present)).toEqual({ credential_id: 'agent:a', map: { autonomy_by_context: { c3: 'supervised' } }, present: true });
    const absent = await invoke(deps(reg(), stores), { id: 'fetch-dossier', version: 'v1', inputs: { credential_id: 'agent:z' } });
    expect(absent.status).toBe('returned');
  });

  it('fetch-run-state: present exposes FLAT dose/stage/status, absent → returned', async () => {
    const stores = new InMemoryStores().seed('run-state', 'run1', { cycle: '3', current_stage: 'final', status: 'active', dose: { stage: 2 }, parent_run_id: null });
    const present = await invoke(deps(reg(), stores), { id: 'fetch-run-state', version: 'v1', inputs: { run_id: 'run1' } });
    // FLAT: the methodology addresses $runst.status / $runst.stage / $runst.dose directly.
    const rs = ok(present) as { status: string; stage: string; cycle: string; dose: unknown };
    expect(rs.status).toBe('active');
    expect(rs.stage).toBe('final');
    expect(rs.cycle).toBe('3');
    expect(rs.dose).toEqual({ stage: 2 });
    const absent = await invoke(deps(reg(), stores), { id: 'fetch-run-state', version: 'v1', inputs: { run_id: 'nope' } });
    expect(absent.status).toBe('returned');
  });
});
