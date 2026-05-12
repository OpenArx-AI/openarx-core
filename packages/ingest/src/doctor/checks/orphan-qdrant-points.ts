/**
 * Doctor check: orphan Qdrant points.
 *
 * Detects points in Qdrant that have no matching chunk in Postgres.
 * Fix: deletes orphan points from Qdrant.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { query } from '@openarx/api';
import { createChildLogger } from '../../lib/logger.js';
import type { CheckModule, CheckResult, FixResult, DoctorContext } from '../types.js';

const log = createChildLogger('doctor:orphan-qdrant');
const COLLECTION = 'chunks';

export function createOrphanQdrantCheck(ctx: DoctorContext): CheckModule {
  const qdrant = new QdrantClient({
    url: ctx.qdrantUrl,
    ...(ctx.qdrantApiKey ? { apiKey: ctx.qdrantApiKey } : {}),
  });

  return {
    name: 'orphan-qdrant-points',
    description: 'Qdrant points with no matching Postgres chunk',
    severity: 'low',

    async detect(): Promise<CheckResult> {
      const orphanIds: string[] = [];
      let offset: string | undefined;

      // Scroll through all Qdrant points, check each against Postgres
      while (true) {
        const page = await qdrant.scroll(COLLECTION, {
          limit: 500,
          offset,
          with_payload: ['chunk_id'],
          with_vector: false,
        });

        if (page.points.length === 0) break;

        // Collect chunk_ids from this page
        const pointMap = new Map<string, string>(); // chunk_id → point_id
        for (const point of page.points) {
          const chunkId = (point.payload as Record<string, unknown>)?.chunk_id as string;
          if (chunkId) pointMap.set(chunkId, String(point.id));
        }

        // Batch check existence in Postgres
        if (pointMap.size > 0) {
          const chunkIds = [...pointMap.keys()];
          const result = await query<{ id: string }>(
            `SELECT id::text FROM chunks WHERE id::text = ANY($1::text[])`,
            [chunkIds],
          );
          const existingIds = new Set(result.rows.map((r) => r.id));

          for (const [chunkId, pointId] of pointMap) {
            if (!existingIds.has(chunkId)) {
              orphanIds.push(pointId);
            }
          }
        }

        offset = page.next_page_offset != null ? String(page.next_page_offset) : undefined;
        if (!offset) break;
      }

      if (orphanIds.length === 0) {
        return { status: 'ok', message: 'No orphan Qdrant points', affectedCount: 0 };
      }

      return {
        status: 'warn',
        message: `${orphanIds.length} orphan Qdrant points (no matching Postgres chunk)`,
        affectedCount: orphanIds.length,
        details: { orphanIds },
      };
    },

    async fix(): Promise<FixResult> {
      // Re-detect to get current orphans
      const detectResult = await this.detect();
      if (detectResult.affectedCount === 0) {
        return { fixed: 0, failed: 0, message: 'No orphans to clean' };
      }

      const allOrphanIds = (detectResult.details as { orphanIds: string[] }).orphanIds;
      const orphanIds = ctx.fixLimit ? allOrphanIds.slice(0, ctx.fixLimit) : allOrphanIds;
      log.info({ count: orphanIds.length, total: allOrphanIds.length, limit: ctx.fixLimit }, 'Deleting orphan Qdrant points');

      let deleted = 0;
      let failed = 0;
      const BATCH = 500;

      for (let i = 0; i < orphanIds.length; i += BATCH) {
        const batch = orphanIds.slice(i, i + BATCH);
        try {
          await qdrant.delete(COLLECTION, { points: batch });
          deleted += batch.length;
        } catch (err) {
          log.error({ err, batch: i }, 'Failed to delete orphan batch');
          failed += batch.length;
        }
      }

      return {
        fixed: deleted,
        failed,
        message: `Deleted ${deleted} orphan points${failed > 0 ? `, ${failed} failed` : ''}`,
      };
    },
  };
}
