/**
 * PgCostTracker — records per-step processing costs into processing_costs table.
 *
 * Matches PipelineContext.costTracker interface from @openarx/types.
 */

import { query } from '@openarx/api';

export class PgCostTracker {
  constructor(private readonly documentId: string) {}

  async record(
    task: string,
    model: string,
    provider: string,
    inputTokens: number,
    outputTokens: number,
    cost: number,
    durationMs: number,
  ): Promise<void> {
    // Guard against NaN/undefined propagating to DB (corrupts SUM aggregates)
    const safeCost = Number.isFinite(cost) ? cost : null;
    const safeInput = Number.isFinite(inputTokens) ? inputTokens : null;
    const safeOutput = Number.isFinite(outputTokens) ? outputTokens : null;

    await query(
      `INSERT INTO processing_costs
        (document_id, task, model, provider, input_tokens, output_tokens, cost, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [this.documentId, task, model, provider, safeInput, safeOutput, safeCost, durationMs],
    );
  }
}
