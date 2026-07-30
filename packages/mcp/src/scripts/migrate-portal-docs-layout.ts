#!/usr/bin/env node
/**
 * One-off migration of existing source='portal' documents to the canonical
 * flat storage layout (contract document_publication_pipeline.md §6/§9,
 * bead openarx-contracts-uhlh). Runs SEPARATELY, before the publish-document
 * endpoint goes live for Portal traffic.
 *
 * Two legacy layouts observed in prod (2026-06-13):
 *   A) {prefix}/{coreDocId}/source/<main>          (early /ingest-document, prefix=_core)
 *   B) {prefix}/indexed/{coreDocId}/source/<main>  (MCP submit_document, prefix=_anonymous)
 * Canonical target:
 *      {prefix}/{coreDocId}/<files...>             (no indexed/, no source/)
 *
 * The move flattens the per-doc `source/` directory up one level into the
 * doc root, drops the `indexed/` segment, and updates raw_content_path,
 * sources, and portal_metadata.content_source.storage_path so file serving
 * and re-processing keep working.
 *
 * Usage:
 *   node dist/scripts/migrate-portal-docs-layout.js            # dry-run (default)
 *   node dist/scripts/migrate-portal-docs-layout.js --live     # perform moves
 *
 * Dry-run writes the planned moves to
 * /mnt/storagebox/openarx/migrations/2026-06-pubpipe-migration.log and a
 * reversing rollback.sh next to it. Review BOTH before --live.
 */
import { rename, mkdir, readdir, writeFile, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { query, pool } from '@openarx/api';

const PORTAL_STORAGE_BASE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';
const MIGRATION_DIR = '/mnt/storagebox/openarx/migrations';
const LOG_PATH = join(MIGRATION_DIR, '2026-06-pubpipe-migration.log');
const ROLLBACK_PATH = join(MIGRATION_DIR, '2026-06-pubpipe-rollback.sh');
const LIVE = process.argv.includes('--live');

interface DocRow {
  id: string;
  raw_content_path: string | null;
  sources: Record<string, unknown> | null;
  portal_metadata: Record<string, unknown> | null;
}

interface Plan {
  id: string;
  currentSourceDir: string; // the dir we move FROM (the per-doc source/ dir)
  targetDir: string;        // canonical {prefix}/{coreDocId}/
  mainFileName: string;
  oldRawPath: string;
  newRawPath: string;
  fileOk: boolean;
  note: string;
}

/** Derive the canonical target dir + flattening plan from the current path. */
function planFor(row: DocRow): Plan | null {
  const raw = row.raw_content_path;
  if (!raw) return null;
  const mainFileName = basename(raw);
  const currentSourceDir = dirname(raw); // .../{id}[/...]/source
  // Target: strip trailing '/source' and any '/indexed' segment.
  let targetDir = currentSourceDir.replace(/\/source$/, '');
  targetDir = targetDir.replace(`/indexed/${row.id}`, `/${row.id}`);
  const newRawPath = join(targetDir, mainFileName);
  return {
    id: row.id,
    currentSourceDir,
    targetDir,
    mainFileName,
    oldRawPath: raw,
    newRawPath,
    fileOk: false,
    note: currentSourceDir === targetDir ? 'already-canonical' : '',
  };
}

function rewritePaths<T>(obj: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(obj).split(from).join(to)) as T;
}

async function main(): Promise<void> {
  await mkdir(MIGRATION_DIR, { recursive: true });
  const { rows } = await query<DocRow>(
    `SELECT id, raw_content_path, sources, portal_metadata
       FROM documents WHERE source = 'portal' ORDER BY created_at`,
  );

  const logLines: string[] = [`# pubpipe layout migration ${LIVE ? 'LIVE' : 'DRY-RUN'} — ${rows.length} docs`];
  const rollbackLines: string[] = ['#!/usr/bin/env bash', 'set -euo pipefail', '# Reverses 2026-06-pubpipe layout migration'];
  let moved = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const plan = planFor(row);
    if (!plan) { logLines.push(`SKIP ${row.id}: no raw_content_path`); skipped++; continue; }
    if (plan.note === 'already-canonical') { logLines.push(`SKIP ${plan.id}: already canonical`); skipped++; continue; }

    try { await access(plan.oldRawPath, constants.R_OK); plan.fileOk = true; } catch { /* file missing */ }
    if (!plan.fileOk) { logLines.push(`FAIL ${plan.id}: main file missing at ${plan.oldRawPath}`); failed++; continue; }

    logLines.push(`MOVE ${plan.id}:`);
    logLines.push(`  files: ${plan.currentSourceDir}/* → ${plan.targetDir}/`);
    logLines.push(`  raw_content_path: ${plan.oldRawPath} → ${plan.newRawPath}`);
    rollbackLines.push(`# ${plan.id}`, `mkdir -p '${plan.currentSourceDir}'`, `mv '${plan.targetDir}'/* '${plan.currentSourceDir}'/ 2>/dev/null || true`);

    if (!LIVE) { moved++; continue; }

    // LIVE: move each entry from the source/ dir up into the target dir.
    await mkdir(plan.targetDir, { recursive: true });
    const entries = await readdir(plan.currentSourceDir);
    for (const e of entries) {
      const dst = join(plan.targetDir, e);
      if (await access(dst).then(() => true, () => false)) continue; // idempotent: skip if present
      await rename(join(plan.currentSourceDir, e), dst);
    }
    // Update DB paths (raw_content_path + sources + portal_metadata).
    const from = plan.currentSourceDir, to = plan.targetDir;
    const newSources = row.sources ? rewritePaths(row.sources, from, to) : row.sources;
    const newPortalMeta = row.portal_metadata ? rewritePaths(row.portal_metadata, from, to) : row.portal_metadata;
    await query(
      `UPDATE documents SET raw_content_path = $1, sources = $2::jsonb, portal_metadata = $3::jsonb WHERE id = $4::uuid`,
      [plan.newRawPath, JSON.stringify(newSources), JSON.stringify(newPortalMeta), plan.id],
    );
    // Clean up now-empty source/ (and indexed/ parent if empty).
    await rm(plan.currentSourceDir, { recursive: true, force: true }).catch(() => {});
    const indexedParent = dirname(dirname(plan.newRawPath)) + '/indexed';
    await rm(join(indexedParent, plan.id), { recursive: true, force: true }).catch(() => {});
    moved++;
  }

  logLines.push(`\n# summary: ${moved} ${LIVE ? 'moved' : 'planned'}, ${skipped} skipped, ${failed} failed`);
  await writeFile(LOG_PATH, logLines.join('\n') + '\n', 'utf-8');
  await writeFile(ROLLBACK_PATH, rollbackLines.join('\n') + '\n', 'utf-8');
  console.log(logLines.join('\n'));
  console.log(`\nLog: ${LOG_PATH}\nRollback: ${ROLLBACK_PATH}`);
  await pool.end();
  process.exit(failed > 0 && LIVE ? 2 : 0);
}

main().catch((err) => { console.error('migration crashed:', err); process.exit(1); });
