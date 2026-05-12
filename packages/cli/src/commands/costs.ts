/**
 * openarx costs — processing cost breakdown.
 */

import { query } from '@openarx/api';

export async function costs(args: string[]): Promise<void> {
  const period = parsePeriod(args);

  if (args.includes('--by-task')) {
    await costsByTask(period);
  } else if (args.includes('--by-model')) {
    await costsByModel(period);
  } else {
    await costsDefault(period);
  }
}

function parsePeriod(args: string[]): string | null {
  const idx = args.indexOf('--period');
  if (idx < 0 || !args[idx + 1]) return null;

  const val = args[idx + 1];
  const match = /^(\d+)d$/.exec(val);
  if (!match) {
    console.error(`Invalid period format: ${val} (expected e.g. "7d")`);
    process.exit(1);
  }

  return `${match[1]} days`;
}

function periodClause(period: string | null, paramIndex: number): { clause: string; params: unknown[] } {
  if (!period) return { clause: '', params: [] };
  return {
    clause: `WHERE created_at > now() - $${paramIndex}::interval`,
    params: [period],
  };
}

async function costsDefault(period: string | null): Promise<void> {
  const { clause, params } = periodClause(period, 1);

  const result = await query<{
    total_cost: string;
    total_input_tokens: string;
    total_output_tokens: string;
    total_calls: string;
  }>(
    `SELECT
       COALESCE(SUM(cost), 0) as total_cost,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       count(*) as total_calls
     FROM processing_costs
     ${clause}`,
    params,
  );

  const row = result.rows[0];
  const cost = parseFloat(row.total_cost);
  const inputTokens = parseInt(row.total_input_tokens, 10);
  const outputTokens = parseInt(row.total_output_tokens, 10);
  const calls = parseInt(row.total_calls, 10);

  console.log('\n=== Processing Costs ===\n');
  if (period) console.log(`  Period: last ${period}\n`);
  console.log(`  Total cost:     $${cost.toFixed(4)}`);
  console.log(`  Input tokens:   ${inputTokens.toLocaleString()}`);
  console.log(`  Output tokens:  ${outputTokens.toLocaleString()}`);
  console.log(`  API calls:      ${calls.toLocaleString()}`);

  if (calls > 0) {
    console.log(`  Avg cost/call:  $${(cost / calls).toFixed(6)}`);
  }
}

async function costsByTask(period: string | null): Promise<void> {
  const { clause, params } = periodClause(period, 1);

  const result = await query<{
    task: string;
    total_cost: string;
    calls: string;
    total_input_tokens: string;
    total_output_tokens: string;
  }>(
    `SELECT
       task,
       SUM(cost) as total_cost,
       count(*) as calls,
       SUM(input_tokens) as total_input_tokens,
       SUM(output_tokens) as total_output_tokens
     FROM processing_costs
     ${clause}
     GROUP BY task
     ORDER BY total_cost DESC`,
    params,
  );

  console.log('\n=== Costs by Task ===\n');
  if (period) console.log(`  Period: last ${period}\n`);
  console.log(
    `  ${'Task'.padEnd(25)} ${'Cost'.padStart(10)} ${'Calls'.padStart(8)} ${'In Tokens'.padStart(12)} ${'Out Tokens'.padStart(12)}`,
  );
  console.log('  ' + '-'.repeat(69));

  for (const row of result.rows) {
    const cost = parseFloat(row.total_cost);
    const calls = parseInt(row.calls, 10);
    const inTok = parseInt(row.total_input_tokens, 10);
    const outTok = parseInt(row.total_output_tokens, 10);

    console.log(
      `  ${row.task.padEnd(25)} ${'$' + cost.toFixed(4).padStart(9)} ${calls.toLocaleString().padStart(8)} ${inTok.toLocaleString().padStart(12)} ${outTok.toLocaleString().padStart(12)}`,
    );
  }
}

async function costsByModel(period: string | null): Promise<void> {
  const { clause, params } = periodClause(period, 1);

  const result = await query<{
    model: string;
    provider: string;
    total_cost: string;
    calls: string;
  }>(
    `SELECT
       model,
       provider,
       SUM(cost) as total_cost,
       count(*) as calls
     FROM processing_costs
     ${clause}
     GROUP BY model, provider
     ORDER BY total_cost DESC`,
    params,
  );

  console.log('\n=== Costs by Model ===\n');
  if (period) console.log(`  Period: last ${period}\n`);
  console.log(
    `  ${'Model'.padEnd(30)} ${'Provider'.padEnd(12)} ${'Cost'.padStart(10)} ${'Calls'.padStart(8)}`,
  );
  console.log('  ' + '-'.repeat(62));

  for (const row of result.rows) {
    const cost = parseFloat(row.total_cost);
    const calls = parseInt(row.calls, 10);

    console.log(
      `  ${row.model.padEnd(30)} ${row.provider.padEnd(12)} ${'$' + cost.toFixed(4).padStart(9)} ${calls.toLocaleString().padStart(8)}`,
    );
  }
}
