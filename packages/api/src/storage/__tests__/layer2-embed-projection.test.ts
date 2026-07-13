/**
 * §5.4.2 v1 deterministic enrich projection — CONTRACT MATERIAL: changing the
 * template output means bumping PAYLOAD_SCHEMA_VERSION (= reindex event).
 * These tests freeze the v1 shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimProjection, PAYLOAD_SCHEMA_VERSION } from '../layer2-embed-projection.js';

test('schema version is v1 (bump = reindex event)', () => {
  assert.equal(PAYLOAD_SCHEMA_VERSION, 'v1');
});

test('bare claim (no context) — [Claim] only', () => {
  assert.equal(
    buildClaimProjection({ text: 'Method X improves accuracy.', edges: [] }),
    '[Claim] Method X improves accuracy.',
  );
});

test('full context: run + edges in every direction + mediator + caveats', () => {
  const out = buildClaimProjection({
    text: 'Attention scales quadratically.',
    statedScopeCaveats: 'Measured up to 32k tokens.',
    runId: 'run-7',
    cycleType: '3',
    edges: [
      { relation: 'support', direction: 'out', neighborText: 'Long-context costs grow fast.' },
      { relation: 'refute', direction: 'in', neighborText: 'Linear attention matches quality.' },
      { relation: 'qualify', direction: 'out', neighborText: 'Costs dominate at inference.', mediator: { variable: 'batch size', condition: '>32' } },
    ],
  });
  assert.equal(
    out,
    '[Context] Run run-7 (cycle 3). ' +
      'It supports: "Long-context costs grow fast.". ' +
      'It is disputed by: "Linear attention matches quality.". ' +
      'It qualifies (given batch size: >32): "Costs dominate at inference.".' +
      '\n[Claim] Attention scales quadratically. Measured up to 32k tokens.',
  );
});

test('deterministic: same input → byte-identical output', () => {
  const input = {
    text: 'T', runId: 'r', cycleType: '1',
    edges: [{ relation: 'extend', direction: 'in' as const, neighborText: 'N' }],
  };
  assert.equal(buildClaimProjection(input), buildClaimProjection(input));
});

test('neighbor text is trimmed to the quote cap with ellipsis', () => {
  const long = 'word '.repeat(80);
  const out = buildClaimProjection({
    text: 'C', edges: [{ relation: 'support', direction: 'out', neighborText: long }],
  });
  assert.match(out, /…"/);
  const quoted = /"([^"]+)"/.exec(out)![1]!;
  assert.ok(quoted.length <= 160);
});

test('unknown relation types get a generic phrase (open set §9.3)', () => {
  const out = buildClaimProjection({
    text: 'C', edges: [{ relation: 'contrasts_with', direction: 'out', neighborText: 'N' }],
  });
  assert.match(out, /It relates \(contrasts_with\) to: "N"\./);
});
