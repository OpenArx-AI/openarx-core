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

  // §4.3 bundle identity (openarx-1ed5): the ACTIVE FRAME_SPECS.bundle scope. members =
  // sorted SET (order-independent); synthesis_narrative EXCLUDED (projection); bundle_type
  // INCLUDED. Guards against the pre-fix CLAIM_SCOPE degeneracy (collapse → collision).
  it('bundle — members = sorted SET; synthesis_narrative EXCLUDED; bundle_type INCLUDED; no degenerate collapse', async () => {
    const r = reg();
    const BUNDLE_SCOPE = {
      include: ['bundle_type', 'members', 'manifest', 'attester_id', 'attested_at'],
      sortFields: ['members'],
    };
    const base = {
      record_type: 'bundle',
      bundle_type: 'narrative_synthesis',
      attester_id: 'agent:a',
      attested_at: '2026-07-01T12:00:00Z',
      members: ['src:claim:bbb', 'src:claim:aaa', 'src:claim:ccc'],
      synthesis_narrative: 'UNIQUENARRATIVEXYZ',
    };
    // element order does NOT change the id (sorted set)
    const shuffled = { ...base, members: ['src:claim:ccc', 'src:claim:bbb', 'src:claim:aaa'] };
    expect(await contentHash(r, BUNDLE_SCOPE, base)).toBe(await contentHash(r, BUNDLE_SCOPE, shuffled));
    const bytes = await canonical(r, BUNDLE_SCOPE, base);
    // synthesis_narrative is a projection — neither key nor value enters the hash
    expect(bytes).not.toContain('synthesis_narrative');
    expect(bytes).not.toContain('UNIQUENARRATIVEXYZ');
    // bundle_type + members ARE in the scope (non-degenerate)
    expect(bytes).toContain('narrative_synthesis');
    expect(bytes).toContain('members');
    // editing the narrative does NOT change the id
    const edited = { ...base, synthesis_narrative: 'a different narrative' };
    expect(await contentHash(r, BUNDLE_SCOPE, edited)).toBe(await contentHash(r, BUNDLE_SCOPE, base));
    // a different member set ⇒ a different id (pre-fix CLAIM_SCOPE would have collided)
    const diff = { ...base, members: ['src:claim:zzz'] };
    expect(await contentHash(r, BUNDLE_SCOPE, diff)).not.toBe(await contentHash(r, BUNDLE_SCOPE, base));
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

// ── redact-fields (closeout verdict-input prose-redaction; bead openarx-mbtx / s4ez) ──
describe('redact-fields', () => {
  const PATHS = ['records[].content.deliverable_document.sections'];
  interface DeliverableDoc {
    genre: string;
    title: string;
    section_outline: string[];
    sections: Record<string, unknown>;
  }
  interface Rec {
    kind: string;
    local_id?: string;
    content?: Record<string, unknown>;
    [k: string]: unknown;
  }
  const closeoutRecord = (): Rec => ({
    kind: 'activity',
    activity_type: 'version_closeout',
    local_id: '_:vc',
    content: {
      carry_forward: ['carry-x'],
      seeds: [{ q: 'seed-q1' }],
      whats_closed: 'stage-8',
      deliverable_document: {
        genre: 'dispute-map',
        title: 'The Title',
        section_outline: ['Intro', 'Body', 'Conclusion'],
        sections: {
          Intro: 'A'.repeat(500),
          Body: 'B'.repeat(3000),
          Conclusion: 'C'.repeat(800),
        },
      },
    },
  });
  const claimRecord = (): Rec => ({ kind: 'claim', local_id: '_:c', content: { text: 'a short claim' } });
  const sub = (records: Rec[]): { submission_hash: string; records: Rec[] } => ({ submission_hash: 'h', records });

  const runRedact = (submission: unknown, paths: unknown = PATHS) =>
    invoke(deps(reg()), { id: 'redact-fields', version: 'v1', params: { paths }, inputs: { submission } });
  const redactedDoc = (o: Outcome<unknown>): DeliverableDoc =>
    (ok(o) as { submission: { records: Rec[] } }).submission.records[0].content!
      .deliverable_document as unknown as DeliverableDoc;

  it('keeps genre/title/section_outline + sections KEYS; drops sections prose to length-markers', async () => {
    const dd = redactedDoc(await runRedact(sub([closeoutRecord()])));
    expect(dd.genre).toBe('dispute-map');
    expect(dd.title).toBe('The Title');
    expect(dd.section_outline).toEqual(['Intro', 'Body', 'Conclusion']);
    // completeness cross-check survives: outline ↔ Object.keys(sections)
    expect(Object.keys(dd.sections)).toEqual(dd.section_outline);
    // prose bodies gone, size signal preserved (non-empty)
    expect(dd.sections.Body).toBe('[prose omitted: 3000 chars]');
    expect(dd.sections.Intro).toBe('[prose omitted: 500 chars]');
  });

  it('no raw prose survives in the redacted output', async () => {
    const out = await runRedact(sub([closeoutRecord()]));
    const json = JSON.stringify((ok(out) as { submission: unknown }).submission);
    expect(json).not.toContain('BBBBB');
    expect(json).not.toContain('AAAAA');
  });

  it('★ §4.3: NEVER mutates the input — the original submission keeps full prose (persist path stays raw)', async () => {
    const original = sub([closeoutRecord()]);
    await runRedact(original);
    const origDoc = original.records[0].content!.deliverable_document as unknown as DeliverableDoc;
    expect(origDoc.sections.Body).toBe('B'.repeat(3000));
    expect(origDoc.sections.Intro).toBe('A'.repeat(500));
  });

  it('path-absent → no-op pass-through (non-closeout submission is deep-equal unchanged)', async () => {
    const claimOnly = sub([claimRecord()]);
    const out = ok(await runRedact(claimOnly)) as { submission: unknown };
    expect(out.submission).toEqual(claimOnly);
  });

  it('mixed submission: claim record untouched, only the closeout record is redacted', async () => {
    const claim = claimRecord();
    const out = ok(await runRedact(sub([claim, closeoutRecord()]))) as { submission: { records: Rec[] } };
    expect(out.submission.records[0]).toEqual(claim);
    const dd = out.submission.records[1].content!.deliverable_document as unknown as DeliverableDoc;
    expect(dd.sections.Body).toBe('[prose omitted: 3000 chars]');
  });

  it('array-valued section → item-count marker (keeps key)', async () => {
    const rec = closeoutRecord();
    (rec.content!.deliverable_document as DeliverableDoc).sections = { Intro: ['p1', 'p2', 'p3'] };
    const dd = redactedDoc(await runRedact(sub([rec])));
    expect(dd.sections.Intro).toBe('[omitted: 3 items]');
  });

  it('malformed params.paths (not a string[]) → rejected (fail-loud on misconfig)', async () => {
    expect((await runRedact(sub([closeoutRecord()]), 'not-an-array')).status).toBe('rejected');
    expect((await runRedact(sub([closeoutRecord()]), [1, 2])).status).toBe('rejected');
  });
});
