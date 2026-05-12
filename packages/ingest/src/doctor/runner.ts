/**
 * Doctor runner — executes all registered checks and aggregates report.
 */

import { createChildLogger } from '../lib/logger.js';
import { getAllChecks } from './checks/index.js';
import type { DoctorContext, DoctorReport } from './types.js';

const log = createChildLogger('doctor');

export async function runDoctor(
  ctx: DoctorContext,
  options: { checkName?: string },
): Promise<DoctorReport> {
  const allChecks = getAllChecks(ctx);

  const checks = options.checkName
    ? allChecks.filter((c) => c.name === options.checkName)
    : allChecks;

  if (options.checkName && checks.length === 0) {
    log.warn({ checkName: options.checkName, available: allChecks.map((c) => c.name) }, 'Check not found');
  }

  const report: DoctorReport = {
    checksRun: 0,
    ok: 0,
    warnings: 0,
    errors: 0,
    results: [],
  };

  for (const check of checks) {
    log.info({ check: check.name }, 'Running check');

    const result = await check.detect();
    report.checksRun++;

    if (result.status === 'ok') report.ok++;
    else if (result.status === 'warn') report.warnings++;
    else report.errors++;

    const entry: DoctorReport['results'][number] = {
      name: check.name,
      severity: check.severity,
      result,
    };

    if (ctx.fix && result.status !== 'ok' && check.fix) {
      log.info({ check: check.name }, 'Applying fix');
      try {
        entry.fixResult = await check.fix();
      } catch (err) {
        entry.fixResult = {
          fixed: 0,
          failed: result.affectedCount,
          message: `Fix failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    report.results.push(entry);
  }

  log.info({
    checksRun: report.checksRun, ok: report.ok, warnings: report.warnings, errors: report.errors,
  }, 'Doctor complete');

  return report;
}
