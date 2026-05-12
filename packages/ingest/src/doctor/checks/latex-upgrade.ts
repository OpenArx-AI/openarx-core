/**
 * Doctor check: latex-upgrade — re-download PDF papers as LaTeX.
 *
 * Detects old-batch papers (source_format=pdf, source_url /pdf/) that
 * may have LaTeX source on arXiv. Fix: downloads e-print, extracts
 * LaTeX, re-processes through pipeline.
 */

import { query } from '@openarx/api';
import { PgDocumentStore, QdrantVectorStore } from '@openarx/api';
import { ArxivSource } from '../../sources/arxiv-source.js';
import { PipelineOrchestrator } from '../../pipeline/orchestrator.js';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';
import { appendProvenance } from '../../lib/provenance.js';
import { arxivDocPath } from '../../utils/doc-path.js';

const log = createChildLogger('doctor:latex-upgrade');
const RATE_LIMIT_MS = 3000;
const DATA_DIR = process.env.RUNNER_DATA_DIR ?? '.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLatexUpgradeCheck(ctx: DoctorContext): CheckModule {
  return {
    name: 'latex-upgrade',
    description: 'PDF papers upgradeable to LaTeX source',
    severity: 'low',

    async detect(): Promise<CheckResult> {
      const result = await query<{ cnt: string }>(
        `SELECT count(*)::text as cnt FROM documents
         WHERE status = 'ready'
           AND (source_format = 'pdf' OR source_format IS NULL)
           AND source_url LIKE '%/pdf/%'
           AND (sources->'latex' IS NULL OR sources->'latex' = 'null'::jsonb)`,
      );

      const count = parseInt(result.rows[0]?.cnt ?? '0', 10);

      if (count === 0) {
        return { status: 'ok', message: 'All eligible papers already have LaTeX source', affectedCount: 0 };
      }

      return {
        status: 'warn',
        message: `${count} papers eligible for LaTeX upgrade (old PDF-only batch)`,
        affectedCount: count,
      };
    },

    async fix(): Promise<FixResult> {
      if (!ctx.modelRouter) {
        return { fixed: 0, failed: 0, message: 'ModelRouter not available' };
      }

      const result = await query<{ id: string; source_id: string }>(
        `SELECT id, source_id FROM documents
         WHERE status = 'ready'
           AND (source_format = 'pdf' OR source_format IS NULL)
           AND source_url LIKE '%/pdf/%'
           AND (sources->'latex' IS NULL OR sources->'latex' = 'null'::jsonb)
         ORDER BY created_at ASC`,
      );

      if (result.rows.length === 0) {
        return { fixed: 0, failed: 0, message: 'No papers to upgrade' };
      }

      const papers = ctx.fixLimit ? result.rows.slice(0, ctx.fixLimit) : result.rows;
      log.info({ count: papers.length, total: result.rows.length, limit: ctx.fixLimit }, 'Upgrading papers to LaTeX');

      const arxivSource = new ArxivSource({ dataDir: DATA_DIR });
      const documentStore = new PgDocumentStore();
      const vectorStore = new QdrantVectorStore();
      if (!ctx.embedClient) {
        return { fixed: 0, failed: 0, message: 'embedClient not available (--fix requires running services)' };
      }
      const orchestrator = new PipelineOrchestrator(
        documentStore, vectorStore, ctx.modelRouter,
        { embedClient: ctx.embedClient },
      );

      let upgraded = 0;
      let skippedPdfOnly = 0;
      let failed = 0;

      for (const paper of papers) {
        try {
          log.info({ sourceId: paper.source_id }, 'Downloading e-print');
          const eprint = await arxivSource.downloadEprint(paper.source_id);

          if (!eprint.hasLatex) {
            // No LaTeX — fix sourceUrl cosmetically, keep as PDF
            await query(
              `UPDATE documents SET source_url = REPLACE(source_url, '/pdf/', '/abs/') WHERE id = $1`,
              [paper.id],
            );
            skippedPdfOnly++;
            log.info({ sourceId: paper.source_id }, 'No LaTeX source, keeping PDF');
            await sleep(RATE_LIMIT_MS);
            continue;
          }

          // Update document with LaTeX source info
          const sourcesUpdate = JSON.stringify({
            pdf: { path: `${arxivDocPath(paper.source_id, DATA_DIR)}/paper.pdf` },
            latex: {
              path: eprint.sourcePath,
              rootTex: eprint.rootTex,
              manifest: eprint.manifest,
              texFiles: eprint.texFiles,
            },
          });

          await query(
            `UPDATE documents SET
              sources = $1::jsonb,
              source_format = 'latex',
              source_url = REPLACE(source_url, '/pdf/', '/abs/')
             WHERE id = $2`,
            [sourcesUpdate, paper.id],
          );

          // Reset status and re-process
          await documentStore.updateStatus(paper.id, 'downloaded', {
            step: 'latex-upgrade',
            status: 'started',
            timestamp: new Date().toISOString(),
          });

          await appendProvenance(paper.id, {
            op: 'doctor:latex-upgrade',
            reason: 'pdf-to-latex',
            source_format: 'latex',
          });
          await orchestrator.processOne(paper.id);
          upgraded++;
          log.info({ sourceId: paper.source_id, rootTex: eprint.rootTex }, 'Upgraded to LaTeX');
        } catch (err) {
          failed++;
          log.error({ sourceId: paper.source_id, err }, 'Upgrade failed');
        }
      }

      return {
        fixed: upgraded,
        failed,
        message: `Upgraded ${upgraded} to LaTeX, ${skippedPdfOnly} PDF-only (no LaTeX on arXiv)${failed > 0 ? `, ${failed} failed` : ''}`,
      };
    },
  };
}
