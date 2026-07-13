import { describe, expect, it } from 'vitest';
import {
  buildRecordId,
  invoke,
  Registry,
  sha256Hex,
  transformPrimitives,
  type AssignId,
  type Outcome,
  type RuntimeDeps,
} from '../src/index.js';
import { InMemoryStores } from '../src/testkit/index.js';
import {
  ACTIVITY,
  ACTIVITY_SCOPE,
  CLAIM,
  CLAIM_BYTES,
  CLAIM_HASH,
  CLAIM_SCOPE,
  REL_SHARED,
  RELATION_SCOPE,
  RELSHARED_HASH,
} from './fixtures/layer2-golden.js';

// deterministic content-hash id allocator (integration wires the platform's).
const stubAssign: AssignId = (record, type, prefix) =>
  `${prefix}:${type}:${sha256Hex(JSON.stringify(record)).slice(0, 16)}`;

function reg(): Registry {
  const r = new Registry();
  r.registerAll(transformPrimitives(stubAssign));
  return r;
}
function deps(r: Registry): RuntimeDeps {
  return { registry: r, stores: new InMemoryStores() };
}
function ok<T>(o: Outcome<T>): T {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${o.status}`);
  return o.outputs;
}
async function canonical(r: Registry, hash_scope: unknown, record: unknown): Promise<string> {
  const out = await invoke(deps(r), { id: 'canonicalize', version: 'v1', params: { hash_scope }, inputs: { record } });
  return (ok(out) as { canonical_bytes: string }).canonical_bytes;
}
async function contentHash(r: Registry, hash_scope: unknown, record: unknown): Promise<string> {
  const bytes = await canonical(r, hash_scope, record);
  const out = await invoke(deps(r), { id: 'compute-hash', version: 'v1', inputs: { bytes } });
  return (ok(out) as { hash: string }).hash;
}

// ── canonicalize (golden, byte-exact) ─────────────────────────────────────────
describe('canonicalize', () => {
  it('claim → frozen golden bytes (byte-for-byte)', async () => {
    expect(await canonical(reg(), CLAIM_SCOPE, CLAIM)).toBe(CLAIM_BYTES);
  });

  it('is independent of input key order', async () => {
    const shuffled = {
      verification: CLAIM.verification,
      evidence: CLAIM.evidence,
      attester_id: CLAIM.attester_id,
      content: CLAIM.content,
      cycle_context: CLAIM.cycle_context,
      attested_at: CLAIM.attested_at,
    };
    expect(await canonical(reg(), CLAIM_SCOPE, shuffled)).toBe(CLAIM_BYTES);
  });

  it('relation shared_evidence keeps shared_* fields, drops hash-excluded, hash matches golden', async () => {
    const r = reg();
    const bytes = await canonical(r, RELATION_SCOPE, REL_SHARED);
    expect(bytes).toContain('shared_source_uri');
    expect(bytes).toContain('interpretation_difference');
    expect(bytes).not.toContain('edge_provenance');
    expect(await contentHash(r, RELATION_SCOPE, REL_SHARED)).toBe(RELSHARED_HASH);
  });

  it('relation non-shared strips stray shared_* fields', async () => {
    const support = { ...REL_SHARED, relation: 'support', shared_source_uri: 'arxiv:9999', interpretation_difference: 'x' };
    const bytes = await canonical(reg(), RELATION_SCOPE, support);
    expect(bytes).not.toContain('shared_source_uri');
    expect(bytes).not.toContain('interpretation_difference');
  });

  it('same_as drops direction/mediator — flipping them keeps the same hash (symmetric)', async () => {
    const r = reg();
    const base = { ...REL_SHARED, relation: 'same_as', direction: 'symmetric', shared_source_uri: undefined, interpretation_difference: undefined };
    const bytes = await canonical(r, RELATION_SCOPE, base);
    expect(bytes).not.toContain('"direction"');
    expect(bytes).not.toContain('mediator');
    const flippedDir = { ...base, direction: 'citing_to_cited' };
    const withMed = { ...base, mediator: { variable: 'v', condition: 'c', rationale: 'r' } };
    const h = await contentHash(r, RELATION_SCOPE, base);
    expect(await contentHash(r, RELATION_SCOPE, flippedDir)).toBe(h);
    expect(await contentHash(r, RELATION_SCOPE, withMed)).toBe(h);
  });

  it('activity omits absent applied_instrument/genre; present values shift the hash', async () => {
    const r = reg();
    const baseBytes = await canonical(r, ACTIVITY_SCOPE, ACTIVITY);
    expect(baseBytes).not.toContain('applied_instrument');
    expect(baseBytes).not.toContain('genre');
    const withInstr = { ...ACTIVITY, applied_instrument: 'methodist_checkpoint' };
    expect(await canonical(r, ACTIVITY_SCOPE, withInstr)).toContain('applied_instrument');
    expect(await contentHash(r, ACTIVITY_SCOPE, withInstr)).not.toBe(await contentHash(r, ACTIVITY_SCOPE, ACTIVITY));
  });
});

// ── compute-hash ──────────────────────────────────────────────────────────────
describe('compute-hash', () => {
  it('sha256 over the golden bytes equals the frozen content_hash', async () => {
    const out = await invoke(deps(reg()), { id: 'compute-hash', version: 'v1', inputs: { bytes: CLAIM_BYTES } });
    expect((ok(out) as { hash: string }).hash).toBe(CLAIM_HASH);
  });

  it('buildRecordId assembles <prefix>:<type>:<hash>', () => {
    expect(buildRecordId('agent:msi:openarx-research', 'claim', CLAIM_HASH)).toBe(
      `agent:msi:openarx-research:claim:${CLAIM_HASH}`,
    );
  });
});

// ── resolve-local-ids ─────────────────────────────────────────────────────────
describe('resolve-local-ids', () => {
  const run = (records: unknown) =>
    invoke(deps(reg()), {
      id: 'resolve-local-ids',
      version: 'v1',
      params: { sourcePrefix: 'agent:t' },
      inputs: { submission: { records } },
    });

  it('resolves cross _: refs from submission.records and returns a complete id_map', async () => {
    const out = await run([
      { local_id: '_:c', kind: 'claim', content: { text: 'c' } },
      { local_id: '_:r', kind: 'relation', source_claim_id: '_:c', target_claim_id: `agent:x:claim:${'a'.repeat(64)}`, relation: 'support' },
    ]);
    const res = ok(out) as { records_resolved: Array<{ record: Record<string, unknown> }>; id_map: Record<string, string> };
    expect(Object.keys(res.id_map)).toEqual(['_:c', '_:r']);
    expect(res.records_resolved[1].record.source_claim_id).toBe(res.id_map['_:c']);
  });

  it('empty submission.records → empty resolution (non-write-path no-op)', async () => {
    expect(ok(await run([]))).toEqual({ records_resolved: [], id_map: {} });
  });

  it('dangling _: ref → rejected', async () => {
    const out = await run([{ local_id: '_:r', kind: 'relation', source_claim_id: '_:missing', target_claim_id: '_:missing', relation: 'support' }]);
    expect(out.status).toBe('rejected');
  });

  it('duplicate local_id → rejected', async () => {
    const out = await run([
      { local_id: '_:c', kind: 'claim', content: { text: 'a' } },
      { local_id: '_:c', kind: 'claim', content: { text: 'b' } },
    ]);
    expect(out.status).toBe('rejected');
  });

  it('hash-level reference cycle → rejected', async () => {
    const out = await run([
      { local_id: '_:a', kind: 'relation', source_claim_id: '_:b', target_claim_id: '_:b', relation: 'support' },
      { local_id: '_:b', kind: 'relation', source_claim_id: '_:a', target_claim_id: '_:a', relation: 'support' },
    ]);
    expect(out.status).toBe('rejected');
  });

  it('resolves a topological acyclic mix (metric → activity → claim), any input order', async () => {
    const out = await run([
      { local_id: '_:m', kind: 'metric', metric_name: 'acc', wasGeneratedBy: '_:a' },
      { local_id: '_:a', kind: 'activity', activity_type: 'run', used: ['_:c'] },
      { local_id: '_:c', kind: 'claim', content: { text: 'c' } },
    ]);
    const res = ok(out) as { id_map: Record<string, string> };
    expect(Object.keys(res.id_map).sort()).toEqual(['_:a', '_:c', '_:m']);
  });
});

// ── resolve-local-ids §12.8 fail-closed identity guard (openarx-xpfz) ──────────
// Uses a SCOPE-AWARE assign stub (mirrors the platform assignRecordId: hashes only the
// §4.3 CLAIM_SCOPE fields) so a flat claim degenerates to an attester-only id — the exact
// production bug. The default stubAssign hashes the whole record, so it can't reproduce it.
describe('resolve-local-ids identity guard (§12.8)', () => {
  const CLAIM_SCOPE_FIELDS = ['content', 'evidence', 'attester_id', 'attested_at', 'cycle_context', 'authority_chain'];
  const scopeAssign: AssignId = (record, type, prefix) => {
    const scope: Record<string, unknown> = {};
    for (const f of CLAIM_SCOPE_FIELDS) if (record[f] !== undefined) scope[f] = record[f];
    return buildRecordId(prefix, type as never, sha256Hex(JSON.stringify(scope)));
  };
  const scopeReg = (): Registry => {
    const r = new Registry();
    r.registerAll(transformPrimitives(scopeAssign));
    return r;
  };
  const run = (records: unknown) =>
    invoke(deps(scopeReg()), { id: 'resolve-local-ids', version: 'v1', params: { sourcePrefix: 'cred:t' }, inputs: { submission: { records } } });
  const claim = (content: unknown) => ({
    kind: 'claim',
    content: { text: content, modality: 'observed', claim_type: 'functional', claim_status: 'proposed', claim_strength: 0.5, extraction_fidelity: 0.9 },
  });

  it('rejects a FLAT claim (no content:{}) — degenerate attester-only identity', async () => {
    const out = await run([{ kind: 'claim', type: 'Safety', statement: 'unit alerts before temperature exits [2,8]C' }]);
    expect(out.status).toBe('rejected');
  });

  it('rejects multiple flat claims that collapse to one id', async () => {
    const out = await run([
      { kind: 'claim', type: 'Safety', statement: 'requirement A' },
      { kind: 'claim', type: 'Functional', statement: 'a completely different requirement B' },
    ]);
    expect(out.status).toBe('rejected');
  });

  it('accepts content-wrapped claims with distinct content → distinct ids', async () => {
    const out = await run([claim('requirement A'), claim('a completely different requirement B')]);
    const res = ok(out) as { records_resolved: Array<{ record: { id: string } }> };
    expect(res.records_resolved).toHaveLength(2);
    expect(res.records_resolved[0].record.id).not.toBe(res.records_resolved[1].record.id);
  });

  it('accepts byte-identical claims as legitimate content-address dedup (same id, no throw)', async () => {
    const out = await run([claim('identical text'), claim('identical text')]);
    const res = ok(out) as { records_resolved: Array<{ record: { id: string } }> };
    expect(res.records_resolved[0].record.id).toBe(res.records_resolved[1].record.id);
  });
});
