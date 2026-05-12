/**
 * Doctor check: coverage-gaps.
 *
 * Finds days with no indexed papers within the known coverage range.
 * Uses coverage_map table if populated, falls back to documents table.
 */

import { query } from '@openarx/api';
import type { CheckModule, CheckResult, DoctorContext } from '../types.js';

export function createCoverageGapsCheck(_ctx: DoctorContext): CheckModule {
  return {
    name: 'coverage-gaps',
    description: 'Days with no indexed papers within coverage range',
    severity: 'medium',

    async detect(): Promise<CheckResult> {
      // Find date range from coverage_map
      const rangeResult = await query<{ min_date: string; max_date: string }>(
        `SELECT MIN(date)::text as min_date, MAX(date)::text as max_date
         FROM coverage_map WHERE source = 'arxiv' AND actual > 0`,
      );

      const minDate = rangeResult.rows[0]?.min_date;
      const maxDate = rangeResult.rows[0]?.max_date;

      if (!minDate || !maxDate) {
        return { status: 'ok', message: 'No coverage data yet', affectedCount: 0 };
      }

      // Find all days in range that are NOT in coverage_map or have actual=0
      const gapsResult = await query<{ gap_date: string }>(
        `SELECT d::date::text as gap_date
         FROM generate_series($1::date, $2::date, '1 day') d
         WHERE NOT EXISTS (
           SELECT 1 FROM coverage_map cm
           WHERE cm.source = 'arxiv' AND cm.date = d::date AND cm.actual > 0
         )
         ORDER BY d`,
        [minDate, maxDate],
      );

      const gaps = gapsResult.rows.map((r) => r.gap_date);

      if (gaps.length === 0) {
        return {
          status: 'ok',
          message: `Full coverage from ${minDate} to ${maxDate} (${daysBetween(minDate, maxDate)} days)`,
          affectedCount: 0,
        };
      }

      // Group consecutive gaps into ranges for readability
      const ranges = groupConsecutiveDays(gaps);
      const rangeStrs = ranges.map((r) => r.length === 1 ? r[0] : `${r[0]} to ${r[r.length - 1]}`);

      return {
        status: 'warn',
        message: `${gaps.length} gap days in coverage: ${rangeStrs.join(', ')}`,
        affectedCount: gaps.length,
        details: {
          rangeStart: minDate,
          rangeEnd: maxDate,
          totalDays: daysBetween(minDate, maxDate),
          gapDays: gaps.length,
          gaps: rangeStrs,
        },
      };
    },

    async fix() {
      return { fixed: 0, failed: 0, message: 'Run ingest --direction backfill to fill gaps' };
    },
  };
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1;
}

function groupConsecutiveDays(days: string[]): string[][] {
  if (days.length === 0) return [];
  const groups: string[][] = [[days[0]]];
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const curr = new Date(days[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86400000;
    if (diff <= 1) {
      groups[groups.length - 1].push(days[i]);
    } else {
      groups.push([days[i]]);
    }
  }
  return groups;
}
