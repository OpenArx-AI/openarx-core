/**
 * Per-request UsageTracker — captures raw LLM/embed call data for the
 * MCP request log. Pure module, instance-per-request, no shared state.
 *
 * Design (openarx-2a5f, search v2 cost-tracking Part 1):
 *
 *   - Each tool invocation gets a fresh tracker via AppContext.usage.
 *   - Tools (and shared helpers like embedQuery) call recordLlm / recordEmbed
 *     after each provider call, capturing tokens + USD cost.
 *   - At end of invocation, MCP middleware calls .snapshot() and merges
 *     the result into the JSONL request log entry.
 *
 * Output is RAW per-call data + convenience aggregates. Analytics
 * (averages, percentiles, dashboards) live downstream — out of scope.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelResponse, EmbedResponse } from '@openarx/types';

export interface LlmCallRecord {
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  finishReason?: string;
}

export interface EmbedCallRecord {
  provider: string;
  model: string;
  inputTokens: number;
  costUsd: number;
}

export interface StageRecord {
  stage: string;
  durationMs: number;
}

export interface UsageSnapshot {
  llmCalls: LlmCallRecord[] | null;
  embedCalls: EmbedCallRecord[] | null;
  stages: StageRecord[] | null;
  llmCostUsdTotal: number;
  embedCostUsdTotal: number;
  llmInputTokensTotal: number;
  llmOutputTokensTotal: number;
}

export class UsageTracker {
  private llm: LlmCallRecord[] = [];
  private embed: EmbedCallRecord[] = [];
  private stages: StageRecord[] = [];

  recordLlm(resp: ModelResponse, task: string): void {
    this.llm.push({
      task,
      provider: resp.provider ?? 'unknown',
      model: resp.model,
      inputTokens: resp.inputTokens ?? 0,
      outputTokens: resp.outputTokens ?? 0,
      costUsd: resp.cost ?? 0,
      ...(resp.finishReason ? { finishReason: resp.finishReason } : {}),
    });
  }

  recordEmbed(resp: EmbedResponse): void {
    this.embed.push({
      provider: resp.provider ?? 'unknown',
      model: resp.model,
      inputTokens: resp.inputTokens ?? 0,
      costUsd: resp.cost ?? 0,
    });
  }

  recordStage(stage: string, durationMs: number): void {
    this.stages.push({ stage, durationMs: Math.round(durationMs) });
  }

  snapshot(): UsageSnapshot {
    const llmCostUsdTotal = sumNumber(this.llm, (r) => r.costUsd);
    const embedCostUsdTotal = sumNumber(this.embed, (r) => r.costUsd);
    const llmInputTokensTotal = sumNumber(this.llm, (r) => r.inputTokens);
    const llmOutputTokensTotal = sumNumber(this.llm, (r) => r.outputTokens);
    return {
      llmCalls: this.llm.length > 0 ? [...this.llm] : null,
      embedCalls: this.embed.length > 0 ? [...this.embed] : null,
      stages: this.stages.length > 0 ? [...this.stages] : null,
      llmCostUsdTotal,
      embedCostUsdTotal,
      llmInputTokensTotal,
      llmOutputTokensTotal,
    };
  }
}

function sumNumber<T>(arr: T[], pick: (t: T) => number): number {
  let s = 0;
  for (const x of arr) s += pick(x) || 0;
  return s;
}

/**
 * Empty-snapshot constant for invocations that bypass middleware
 * (e.g. internal-routes path) or for tools that genuinely do no
 * LLM/embed work. Avoids re-creating the same shape repeatedly.
 */
export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = {
  llmCalls: null,
  embedCalls: null,
  stages: null,
  llmCostUsdTotal: 0,
  embedCostUsdTotal: 0,
  llmInputTokensTotal: 0,
  llmOutputTokensTotal: 0,
};

// ─── AsyncLocalStorage threading ──────────────────────────────
//
// Per-request UsageTracker instance is threaded through async call
// stack via AsyncLocalStorage. Tool handlers and shared helpers
// (embedQuery, etc.) call module-level recordLlm/recordEmbed which
// look up the active tracker without explicit ctx threading.
//
// AppContext remains shared across requests — DO NOT add a usage
// field there (race conditions on parallel requests).

const usageStorage = new AsyncLocalStorage<UsageTracker>();

/** Run `fn` with a fresh UsageTracker scoped to the async stack. */
export function withUsageTracker<T>(tracker: UsageTracker, fn: () => Promise<T>): Promise<T> {
  return usageStorage.run(tracker, fn);
}

/** Module-level recorder — looks up active tracker, no-op if not set
 *  (e.g. internal-routes path or tests without middleware). */
export function recordLlm(resp: ModelResponse, task: string): void {
  usageStorage.getStore()?.recordLlm(resp, task);
}

export function recordEmbed(resp: EmbedResponse): void {
  usageStorage.getStore()?.recordEmbed(resp);
}

/** Module-level stage timing recorder. */
export function recordStage(stage: string, durationMs: number): void {
  usageStorage.getStore()?.recordStage(stage, durationMs);
}

/** Convenience wrapper: time a promise-returning step under a stage name. */
export async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordStage(stage, performance.now() - t0);
  }
}

/** Read current tracker (e.g. for inspection in middleware). */
export function getActiveTracker(): UsageTracker | undefined {
  return usageStorage.getStore();
}
