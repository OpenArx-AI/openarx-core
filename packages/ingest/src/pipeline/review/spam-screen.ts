/**
 * Aspect 1 — Spam / emptiness screening.
 *
 * Contract: contracts/content_review.md §3 Aspect 1 (APPROVED 2026-04-22).
 * Runs synchronously before `documentStore.saveDocument` in the
 * /api/internal/ingest-document handler.
 *
 * Two stages:
 *
 *   1. Deterministic checks — cheap rule-based rejection for obviously
 *      empty/garbage submissions. No LLM call. These catch ~20% of bad
 *      submissions for free.
 *
 *   2. LLM classifier (gemini-3-flash-preview via the in-process VertexLlm
 *      path) — asks the model whether the text reads as genuine scientific
 *      content or as spam/garbage/auto-generated. Threshold-calibrated
 *      against a labeled sample (see Commit 5 tuning).
 *
 * Degradation path: if the LLM is unavailable (Vertex + OpenRouter fallback
 * both fail after retries), and deterministic checks have already passed,
 * return `borderline` with reason `LLM_SKIPPED_UPSTREAM_UNAVAILABLE`.
 * Publish proceeds — aspect 1 is a gate, not a blocker for infra outage.
 *
 * Failure-closed only when deterministic checks themselves error
 * (malformed input). Those return `failed` and the handler emits 503 to
 * Portal.
 *
 * Target latency budget: <2s p95 total (deterministic <10ms,
 * LLM ~600ms p50 / 1.5s p95, plus a hard 3s timeout cap).
 */

import type { ModelResponse, ModelOptions } from '@openarx/types';

export type SpamVerdict = 'pass' | 'borderline' | 'reject';

export interface SpamReason {
  code: SpamReasonCode;
  detail?: string;
}

export type SpamReasonCode =
  /** Deterministic rejects */
  | 'EMPTY_BODY'
  | 'BELOW_MIN_LENGTH'
  | 'NO_ABSTRACT'
  | 'ABSTRACT_TOO_SHORT'
  | 'BOILERPLATE_DETECTED'
  | 'ALL_CAPS_BODY'
  | 'REPETITIVE_CONTENT'
  /** LLM-derived */
  | 'LLM_FLAGGED_SPAM'
  | 'LLM_FLAGGED_BORDERLINE'
  | 'LLM_LOW_CONFIDENCE'
  /** Degradation */
  | 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE'
  | 'LLM_TIMEOUT'
  /** Positive signals (for pass verdict) */
  | 'LLM_CLASSIFIED_GENUINE';

export interface SpamScreenInput {
  /** Document title (ingested from Portal / publish form). */
  title: string;
  /** Abstract text (may be empty). */
  abstract: string;
  /** Parsed body — first ~2000 chars of document body content. */
  body: string;
  /** Parser's section count if already available. 0/undefined → no
   *  section signal. */
  sectionCount?: number;
}

export interface SpamScreenResult {
  verdict: SpamVerdict;
  reasons: SpamReason[];
  /** USD cost of LLM call (0 if LLM skipped or failed). */
  llmCost: number;
  /** true if we attempted an LLM call (regardless of success). Observability. */
  llmAttempted: boolean;
}

/** Minimal model-router interface needed by spam-screen. Designed so the
 *  full DefaultModelRouter from @openarx/api satisfies it naturally but
 *  tests can pass a simple mock without constructing the real router. */
export interface SpamScreenModelRouter {
  complete(
    task: 'spam_screen',
    prompt: string,
    options?: ModelOptions,
  ): Promise<ModelResponse>;
}

export interface SpamScreenDeps {
  /** If null, skip LLM and mark as degraded. */
  modelRouter: SpamScreenModelRouter | null;
  /** Override LLM model. Default gemini-3-flash-preview (cheap + fast). */
  model?: string;
  /** Hard timeout for LLM call (ms). Default 3000. */
  timeoutMs?: number;
  /** Minimum body length (chars) below which we short-circuit to reject
   *  without an LLM call. Default 100. Genuine preprints are generally
   *  >10kB; 100 chars is universally too short. */
  hardRejectMinBodyChars?: number;
  /** Soft-signal threshold (chars) — feeds an LLM reason if body is
   *  short but not hard-reject. Default 500 per design review. */
  softMinBodyChars?: number;
  /** Minimum abstract length (chars) for "abstract present" signal.
   *  Default 100. */
  minAbstractChars?: number;
}

const DEFAULT_DEPS: Required<Omit<SpamScreenDeps, 'modelRouter' | 'model'>> = {
  timeoutMs: 3000,
  hardRejectMinBodyChars: 100,
  softMinBodyChars: 500,
  minAbstractChars: 100,
};

const DEFAULT_MODEL = 'gemini-3-flash-preview';

/** Public entry point. Always resolves — never throws (callers rely on
 *  verdict/reasons, not exceptions). On catastrophic failure returns a
 *  degraded borderline result so publish proceeds. */
export async function runSpamScreen(
  input: SpamScreenInput,
  deps: SpamScreenDeps,
): Promise<SpamScreenResult> {
  const cfg = { ...DEFAULT_DEPS, ...deps };

  // ── 1. Deterministic checks ──
  const hardReject = checkHardReject(input, cfg);
  if (hardReject) {
    return {
      verdict: 'reject',
      reasons: hardReject,
      llmCost: 0,
      llmAttempted: false,
    };
  }

  const softSignals = collectSoftSignals(input, cfg);

  // ── 2. LLM classifier ──
  if (!deps.modelRouter) {
    return {
      verdict: 'borderline',
      reasons: [
        ...softSignals,
        { code: 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE' },
      ],
      llmCost: 0,
      llmAttempted: false,
    };
  }

  const prompt = buildPrompt(input);
  let llmResult: ModelResponse;
  try {
    llmResult = await withTimeout(
      deps.modelRouter.complete('spam_screen', prompt, {
        model: deps.model ?? DEFAULT_MODEL,
        maxTokens: 300,
        temperature: 0,
      }),
      cfg.timeoutMs,
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'spam_screen_timeout';
    return {
      verdict: 'borderline',
      reasons: [
        ...softSignals,
        { code: isTimeout ? 'LLM_TIMEOUT' : 'LLM_SKIPPED_UPSTREAM_UNAVAILABLE',
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
      ],
      llmCost: 0,
      llmAttempted: true,
    };
  }

  const parsed = parseLlmResponse(llmResult.text);

  if (parsed === null) {
    // LLM returned non-JSON or malformed — degrade.
    return {
      verdict: 'borderline',
      reasons: [
        ...softSignals,
        { code: 'LLM_LOW_CONFIDENCE', detail: 'malformed LLM response' },
      ],
      llmCost: llmResult.cost,
      llmAttempted: true,
    };
  }

  const llmReasons = parsed.reasons.map((code): SpamReason => ({
    code: 'LLM_FLAGGED_SPAM',
    detail: code,
  }));

  const allReasons: SpamReason[] = [...softSignals];

  if (parsed.verdict === 'genuine') {
    allReasons.push({ code: 'LLM_CLASSIFIED_GENUINE', detail: `confidence=${parsed.confidence.toFixed(2)}` });
    return {
      verdict: 'pass',
      reasons: allReasons,
      llmCost: llmResult.cost,
      llmAttempted: true,
    };
  }

  if (parsed.verdict === 'borderline' || parsed.confidence < 0.6) {
    allReasons.push({ code: 'LLM_FLAGGED_BORDERLINE', detail: `confidence=${parsed.confidence.toFixed(2)}` });
    if (parsed.verdict === 'spam') {
      allReasons.push({ code: 'LLM_LOW_CONFIDENCE', detail: 'LLM flagged spam with low confidence' });
    }
    return {
      verdict: 'borderline',
      reasons: allReasons,
      llmCost: llmResult.cost,
      llmAttempted: true,
    };
  }

  // verdict=spam with confidence >= 0.6 → reject
  return {
    verdict: 'reject',
    reasons: [...softSignals, ...llmReasons,
      { code: 'LLM_FLAGGED_SPAM', detail: `confidence=${parsed.confidence.toFixed(2)}` }],
    llmCost: llmResult.cost,
    llmAttempted: true,
  };
}

// ── Internals ──────────────────────────────────────────────

function checkHardReject(
  input: SpamScreenInput,
  cfg: Required<Omit<SpamScreenDeps, 'modelRouter' | 'model'>>,
): SpamReason[] | null {
  const body = input.body.trim();
  if (body.length === 0) {
    return [{ code: 'EMPTY_BODY' }];
  }
  if (body.length < cfg.hardRejectMinBodyChars) {
    return [{ code: 'BELOW_MIN_LENGTH', detail: `${body.length} chars` }];
  }
  // Obvious repetition: same short phrase repeated >10 times.
  const repetitive = detectRepetitive(body);
  if (repetitive) {
    return [{ code: 'REPETITIVE_CONTENT', detail: repetitive }];
  }
  return null;
}

function collectSoftSignals(
  input: SpamScreenInput,
  cfg: Required<Omit<SpamScreenDeps, 'modelRouter' | 'model'>>,
): SpamReason[] {
  const reasons: SpamReason[] = [];
  const body = input.body.trim();
  const abstract = input.abstract.trim();
  if (body.length < cfg.softMinBodyChars) {
    reasons.push({ code: 'BELOW_MIN_LENGTH', detail: `body ${body.length} chars (< ${cfg.softMinBodyChars})` });
  }
  if (abstract.length === 0) {
    reasons.push({ code: 'NO_ABSTRACT' });
  } else if (abstract.length < cfg.minAbstractChars) {
    reasons.push({ code: 'ABSTRACT_TOO_SHORT', detail: `${abstract.length} chars` });
  }
  if (input.sectionCount !== undefined && input.sectionCount === 0) {
    // fold under NO_ABSTRACT semantically — parser found no structure
    if (!reasons.find((r) => r.code === 'NO_ABSTRACT')) {
      reasons.push({ code: 'NO_ABSTRACT', detail: 'no sections parsed' });
    }
  }
  if (isMostlyUppercase(body)) {
    reasons.push({ code: 'ALL_CAPS_BODY' });
  }
  return reasons;
}

/** Very small heuristic: short repeated substring filling >60% of body. */
function detectRepetitive(body: string): string | null {
  if (body.length < 200) return null;
  for (const len of [5, 10, 20, 40]) {
    const sample = body.slice(0, len).toLowerCase();
    if (sample.trim().length < len) continue;
    const occurrences = (body.toLowerCase().match(new RegExp(escapeRegex(sample), 'g')) ?? []).length;
    if (occurrences * len > body.length * 0.6) {
      return `repeated "${sample.trim().slice(0, 30)}" ~${occurrences}x`;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when >=60% of alphabetic chars in body are uppercase (ignoring
 *  the opening section of a paper which might be all-caps title). */
function isMostlyUppercase(body: string): boolean {
  const sample = body.slice(200, 2000); // skip title area
  let upper = 0;
  let lower = 0;
  for (const c of sample) {
    if (c >= 'A' && c <= 'Z') upper++;
    else if (c >= 'a' && c <= 'z') lower++;
  }
  if (upper + lower < 100) return false;
  return upper / (upper + lower) > 0.6;
}

function buildPrompt(input: SpamScreenInput): string {
  const abs = input.abstract.trim().slice(0, 1500);
  const body = input.body.trim().slice(0, 2000);
  return [
    'Classify this submission. Respond with ONLY a JSON object, no prose.',
    '',
    'Output schema:',
    '{',
    '  "verdict": "genuine" | "borderline" | "spam",',
    '  "reasons": ["<short_code>", ...],',
    '  "confidence": 0.0-1.0',
    '}',
    '',
    'Reason codes (pick 1-3 that apply):',
    '  - nonsensical_text',
    '  - auto_generated_boilerplate',
    '  - non_scientific_topic',
    '  - copy_paste_from_known_source',
    '  - low_information_density',
    '  - genuine_research_content',
    '',
    `Title: ${input.title.trim().slice(0, 300)}`,
    `Abstract: ${abs || '(empty)'}`,
    `Body (first 2000 chars): ${body}`,
  ].join('\n');
}

interface ParsedLlmOutput {
  verdict: 'genuine' | 'borderline' | 'spam';
  reasons: string[];
  confidence: number;
}

export function parseLlmResponse(text: string): ParsedLlmOutput | null {
  const stripped = text.trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '');
  try {
    const obj = JSON.parse(stripped) as Partial<ParsedLlmOutput>;
    if (obj.verdict !== 'genuine' && obj.verdict !== 'borderline' && obj.verdict !== 'spam') return null;
    if (!Array.isArray(obj.reasons)) return null;
    const conf = typeof obj.confidence === 'number' ? obj.confidence : NaN;
    if (Number.isNaN(conf) || conf < 0 || conf > 1) return null;
    return {
      verdict: obj.verdict,
      reasons: obj.reasons.filter((r): r is string => typeof r === 'string'),
      confidence: conf,
    };
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('spam_screen_timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
