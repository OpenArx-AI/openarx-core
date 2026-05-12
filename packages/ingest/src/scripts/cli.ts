#!/usr/bin/env node
/**
 * CLI for the pipeline runner daemon.
 *
 * Usage:
 *   openarx ingest --limit 200
 *   openarx ingest --limit 200 --direction forward
 *   openarx status
 *   openarx coverage
 *   openarx stop
 *   openarx history --limit 10
 */

import { sendCommand } from '../runner/RunnerSocket.js';
import type { RunnerCommand, StatusResult, CoverageResult, PipelineRun, AuditResult } from '../runner/types.js';
import type { DoctorReport } from '../doctor/types.js';

const SOCKET_PATH = process.env.RUNNER_SOCKET ?? '/run/openarx/runner.sock';

function parseArgs(): RunnerCommand {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'ingest': {
      let limit = 100;
      let direction: 'forward' | 'backfill' | undefined;
      let retry = false;
      let dateFrom: string | undefined;
      let dateTo: string | undefined;
      let strategy: 'license_aware' | 'force_full' | undefined;
      let bypassEmbedCache = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[i + 1], 10);
          i++;
        } else if (args[i] === '--direction' && args[i + 1]) {
          direction = args[i + 1] as 'forward' | 'backfill';
          i++;
        } else if (args[i] === '--retry') {
          retry = true;
        } else if (args[i] === '--dateFrom' && args[i + 1]) {
          dateFrom = args[i + 1];
          i++;
        } else if (args[i] === '--dateTo' && args[i + 1]) {
          dateTo = args[i + 1];
          i++;
        } else if (args[i] === '--strategy' && args[i + 1]) {
          const v = args[i + 1];
          if (v !== 'license_aware' && v !== 'force_full') {
            console.error("Error: --strategy must be 'license_aware' or 'force_full'.");
            process.exit(1);
          }
          strategy = v;
          i++;
        } else if (args[i] === '--bypass-cache') {
          bypassEmbedCache = true;
        }
      }
      if (retry && direction) {
        console.error('Error: --retry and --direction are mutually exclusive.');
        process.exit(1);
      }
      return { type: 'ingest', limit, direction, retry, dateFrom, dateTo, strategy, bypassEmbedCache };
    }
    case 'status':
      return { type: 'status' };
    case 'coverage':
      return { type: 'coverage' };
    case 'stop':
      return { type: 'stop' };
    case 'history': {
      let limit = 10;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[i + 1], 10);
          i++;
        }
      }
      return { type: 'history', limit };
    }
    case 'audit': {
      let days: number | undefined;
      let date: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--days' && args[i + 1]) {
          days = parseInt(args[i + 1], 10);
          i++;
        } else if (args[i] === '--date' && args[i + 1]) {
          date = args[i + 1];
          i++;
        }
      }
      return { type: 'audit', days, date };
    }
    case 'doctor': {
      let fix = false;
      let check: string | undefined;
      let limit: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--fix') {
          fix = true;
        } else if (args[i] === '--check' && args[i + 1]) {
          check = args[i + 1];
          i++;
        } else if (args[i] === '--limit' && args[i + 1]) {
          limit = parseInt(args[i + 1], 10);
          i++;
        }
      }
      return { type: 'doctor', fix, check, limit };
    }
    default:
      console.error('Usage: openarx <ingest|status|coverage|stop|history|audit|doctor>');
      console.error('  ingest  --limit N [--direction forward|backfill] [--retry] [--strategy ...] [--bypass-cache]');
      console.error('  audit   [--days N] [--date YYYYMMDD]');
      console.error('  doctor  [--fix] [--check <name>] [--limit N]');
      console.error('  status');
      console.error('  coverage');
      console.error('  stop');
      console.error('  history --limit N');
      process.exit(1);
  }
}

function formatDate(d: string | null): string {
  if (!d) return 'N/A';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return 'running';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

async function main(): Promise<void> {
  const cmd = parseArgs();

  try {
    const resp = await sendCommand(SOCKET_PATH, cmd);

    if (!resp.ok) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    switch (cmd.type) {
      case 'ingest': {
        const run = resp.data as PipelineRun;
        console.log(`Ingest started: ${run.id}`);
        console.log(`  Direction: ${run.direction}`);
        console.log(`  Categories: ${run.categories.join(', ')}`);
        console.log(`  Started: ${formatDate(run.startedAt)}`);
        console.log('\nUse "openarx status" to check progress.');
        break;
      }
      case 'status': {
        const status = resp.data as StatusResult;
        if (status.state === 'idle') {
          console.log('Status: Idle');
        } else {
          const r = status.currentRun!;
          console.log(`Status: Running`);
          console.log(`  Run ID: ${r.id}`);
          console.log(`  Direction: ${r.direction}`);
          console.log(`  Processed: ${r.docsProcessed}`);
          console.log(`  Failed: ${r.docsFailed}`);
          console.log(`  Skipped: ${r.docsSkipped}`);
          console.log(`  Started: ${formatDate(r.startedAt)}`);
          console.log(`  Last ID: ${r.lastProcessedId ?? 'N/A'}`);
        }
        break;
      }
      case 'coverage': {
        const cov = resp.data as CoverageResult;
        console.log(`Coverage (${cov.source}):`);
        console.log(`  Forward cursor: ${formatDate(cov.forwardCursor)}`);
        console.log(`  Backfill cursor: ${formatDate(cov.backfillCursor)}`);
        console.log(`  Total papers: ${cov.totalPapers}`);
        if (cov.runs.length > 0) {
          console.log('  Runs:');
          for (const r of cov.runs) {
            console.log(`    ${r.direction}: ${formatDate(r.dateFrom)} → ${formatDate(r.dateTo)} (${r.docsProcessed} papers)`);
          }
        }
        break;
      }
      case 'stop': {
        const status = resp.data as StatusResult;
        if (status.state === 'idle') {
          console.log('No active run to stop.');
        } else {
          console.log('Stop requested. Waiting for current document to finish.');
        }
        break;
      }
      case 'history': {
        const runs = resp.data as PipelineRun[];
        if (runs.length === 0) {
          console.log('No pipeline runs found.');
          break;
        }
        console.log('Pipeline History:');
        console.log('');
        for (const r of runs) {
          const dur = formatDuration(r.startedAt, r.finishedAt);
          const cost = r.totalCost !== null ? `$${r.totalCost.toFixed(2)}` : '-';
          console.log(`  ${r.status.toUpperCase().padEnd(10)} ${r.direction.padEnd(9)} ${formatDate(r.startedAt)}  ${dur.padEnd(8)} ${r.docsProcessed}ok/${r.docsFailed}fail/${r.docsSkipped}skip  ${cost}`);
          if (r.dateFrom || r.dateTo) {
            console.log(`             coverage: ${formatDate(r.dateFrom)} → ${formatDate(r.dateTo)}`);
          }
        }
        break;
      }
      case 'doctor': {
        const d = resp.data as DoctorReport;
        console.log('');
        console.log('OpenArx Doctor — Data Integrity Report');
        console.log('');
        if (d.results.length === 0) {
          console.log('  No checks registered. Add check modules to doctor/checks/index.ts');
        }
        for (const r of d.results) {
          const icon = r.result.status === 'ok' ? '✅' : r.result.status === 'warn' ? '⚠️ ' : '❌';
          const sev = r.result.status !== 'ok' ? `  [${r.severity}]` : '';
          console.log(`  ${icon} ${r.name.padEnd(28)} ${r.result.message}${sev}`);
          if (r.fixResult) {
            console.log(`     → Fixed: ${r.fixResult.fixed}, Failed: ${r.fixResult.failed} — ${r.fixResult.message}`);
          }
        }
        console.log('');
        console.log(`Summary: ${d.checksRun} checks, ${d.ok} ok, ${d.warnings} warnings, ${d.errors} errors`);
        break;
      }
      case 'audit': {
        const a = resp.data as AuditResult;
        console.log('Audit Report:');
        console.log(`  Days checked: ${a.daysChecked}`);
        console.log(`  Days complete: ${a.daysComplete}`);
        console.log(`  Days with gaps: ${a.daysWithGaps}`);
        for (const d of a.details) {
          if (d.missing > 0) {
            console.log(`    ${d.day}: arXiv=${d.arxivCount}, DB=${d.dbCount}, missing=${d.missing} → downloaded ${d.downloaded}`);
          }
        }
        console.log(`  Total missing: ${a.totalMissing}`);
        console.log(`  Total downloaded: ${a.totalDownloaded}`);
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Cannot connect')) {
      console.error('Runner daemon is not running. Start it with: systemctl start openarx-runner');
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}

main();
