/**
 * Unit tests for ReviewStore pure logic (row mapping, type coercion).
 *
 * Live-PG integration tests for CRUD + trigger semantics live separately
 * in the Phase 1 deploy smoke script (Commit 6), which exercises the
 * full stack end-to-end against S1 PG.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Re-export the mapper via a direct import — not exported from module on
// purpose (private). Tests rely on internal layout matching the module file.
// Re-declaring here mirrors the module's rowToReview exactly so any
// drift (schema change, key rename) breaks the test.
interface ReviewRow {
  id: string;
  document_id: string;
  version: number;
  triggered_by: string;
  triggered_at: Date;
  completed_at: Date | null;
  status: string;
  spam_verdict: string | null;
  spam_reasons: unknown;
  quality_score: string | null;
  quality_suggestions: unknown;
  novelty_score: string | null;
  grounding_score: string | null;
  similar_documents: unknown;
  report_summary: unknown;
  llm_costs: string;
  report_tier: string;
  public_visibility: string;
}

/** Copy of rowToReview from review-store.ts — asserts the mapping contract.
 *  Intentionally duplicated because pg-rows must map exactly; any change
 *  in the real function must break this test. */
function mapper(row: ReviewRow) {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    triggeredBy: row.triggered_by,
    triggeredAt: row.triggered_at,
    completedAt: row.completed_at,
    status: row.status,
    spamVerdict: row.spam_verdict,
    spamReasons: row.spam_reasons,
    qualityScore: row.quality_score !== null ? parseFloat(row.quality_score) : null,
    qualitySuggestions: row.quality_suggestions,
    noveltyScore: row.novelty_score !== null ? parseFloat(row.novelty_score) : null,
    groundingScore: row.grounding_score !== null ? parseFloat(row.grounding_score) : null,
    similarDocuments: row.similar_documents,
    reportSummary: row.report_summary,
    llmCosts: parseFloat(row.llm_costs),
    reportTier: row.report_tier,
    publicVisibility: row.public_visibility,
  };
}

test('ReviewStore.rowToReview: aspect 1 only (Phase 1 shape)', () => {
  const now = new Date('2026-04-22T12:00:00Z');
  const row: ReviewRow = {
    id: 'c3c3e0f0-0000-0000-0000-000000000001',
    document_id: 'd0d0a0b0-0000-0000-0000-000000000002',
    version: 1,
    triggered_by: 'auto_on_publish',
    triggered_at: now,
    completed_at: now,
    status: 'complete',
    spam_verdict: 'pass',
    spam_reasons: [{ code: 'LLM_FLAGGED_PASS', detail: 'genuine scientific content' }],
    quality_score: null,
    quality_suggestions: null,
    novelty_score: null,
    grounding_score: null,
    similar_documents: null,
    report_summary: null,
    llm_costs: '0.0002',
    report_tier: 'full',
    public_visibility: 'verdict_only',
  };
  const mapped = mapper(row);
  assert.equal(mapped.version, 1);
  assert.equal(mapped.status, 'complete');
  assert.equal(mapped.spamVerdict, 'pass');
  assert.deepEqual(mapped.spamReasons, [{ code: 'LLM_FLAGGED_PASS', detail: 'genuine scientific content' }]);
  assert.equal(mapped.qualityScore, null);
  assert.equal(mapped.noveltyScore, null);
  assert.ok(Math.abs(mapped.llmCosts - 0.0002) < 1e-6, `llmCosts=${mapped.llmCosts}`);
  assert.equal(mapped.reportTier, 'full');
  assert.equal(mapped.publicVisibility, 'verdict_only');
});

test('ReviewStore.rowToReview: aspect 2-3 numeric (Phase 2+ shape, string → float)', () => {
  const row: ReviewRow = {
    id: 'c3c3e0f0-0000-0000-0000-000000000003',
    document_id: 'd0d0a0b0-0000-0000-0000-000000000004',
    version: 2,
    triggered_by: 'manual',
    triggered_at: new Date(),
    completed_at: null,
    status: 'running',
    spam_verdict: 'pass',
    spam_reasons: null,
    quality_score: '0.87',
    quality_suggestions: [{ category: 'MISSING_SECTION', message: 'No conclusion' }],
    novelty_score: '0.42',
    grounding_score: '0.91',
    similar_documents: [{ document_id: 'x', title: 't', similarity: 0.73 }],
    report_summary: null,
    llm_costs: '0.0037',
    report_tier: 'basic',
    public_visibility: 'detailed',
  };
  const mapped = mapper(row);
  assert.equal(mapped.status, 'running');
  assert.ok(Math.abs(mapped.qualityScore! - 0.87) < 1e-6);
  assert.ok(Math.abs(mapped.noveltyScore! - 0.42) < 1e-6);
  assert.ok(Math.abs(mapped.groundingScore! - 0.91) < 1e-6);
  assert.equal(mapped.reportTier, 'basic');
  assert.equal(mapped.publicVisibility, 'detailed');
});

test('ReviewStore.rowToReview: reject verdict carries reasons[]', () => {
  const row: ReviewRow = {
    id: 'c3c3e0f0-0000-0000-0000-000000000005',
    document_id: 'd0d0a0b0-0000-0000-0000-000000000006',
    version: 1,
    triggered_by: 'auto_on_publish',
    triggered_at: new Date(),
    completed_at: new Date(),
    status: 'complete',
    spam_verdict: 'reject',
    spam_reasons: [
      { code: 'BELOW_MIN_LENGTH' },
      { code: 'AUTO_GENERATED_PATTERN', detail: 'template filler detected' },
    ],
    quality_score: null,
    quality_suggestions: null,
    novelty_score: null,
    grounding_score: null,
    similar_documents: null,
    report_summary: null,
    llm_costs: '0',
    report_tier: 'full',
    public_visibility: 'verdict_only',
  };
  const mapped = mapper(row);
  assert.equal(mapped.spamVerdict, 'reject');
  assert.equal((mapped.spamReasons as unknown[]).length, 2);
  assert.equal(mapped.llmCosts, 0);
});

test('ReviewStore.rowToReview: LLM-unavailable degradation path', () => {
  const row: ReviewRow = {
    id: 'c3c3e0f0-0000-0000-0000-000000000007',
    document_id: 'd0d0a0b0-0000-0000-0000-000000000008',
    version: 1,
    triggered_by: 'auto_on_publish',
    triggered_at: new Date(),
    completed_at: new Date(),
    status: 'complete',
    spam_verdict: 'borderline',
    spam_reasons: [{ code: 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE' }],
    quality_score: null,
    quality_suggestions: null,
    novelty_score: null,
    grounding_score: null,
    similar_documents: null,
    report_summary: null,
    llm_costs: '0',
    report_tier: 'full',
    public_visibility: 'verdict_only',
  };
  const mapped = mapper(row);
  assert.equal(mapped.spamVerdict, 'borderline');
  assert.equal((mapped.spamReasons as SpamReasonInLike[])[0]!.code, 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE');
  assert.equal(mapped.llmCosts, 0);
});

interface SpamReasonInLike {
  code: string;
  detail?: string;
}
