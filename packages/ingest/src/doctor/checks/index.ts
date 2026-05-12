/**
 * Check module registry — add new checks here.
 */

import type { CheckModule, DoctorContext } from '../types.js';
import { createMissingQdrantCheck } from './missing-qdrant-chunks.js';
import { createOversizedChunksCheck } from './oversized-chunks.js';
import { createOrphanQdrantCheck } from './orphan-qdrant-points.js';
import { createLatexUpgradeCheck } from './latex-upgrade.js';
import { createFlatSectionPathsCheck } from './flat-section-paths.js';
import { createCoverageGapsCheck } from './coverage-gaps.js';
import { createLicenseBackfillCheck } from './license-backfill.js';
import { createStuckPendingCheck } from './stuck-pending.js';
import { createStuckPendingChunksCheck } from './stuck-pending-chunks.js';
import { createPartialChunksCheck } from './partial-chunks.js';
import { createCoverageBreakdownDriftCheck } from './coverage-breakdown-drift.js';

export function getAllChecks(ctx: DoctorContext): CheckModule[] {
  return [
    createMissingQdrantCheck(ctx),
    createOversizedChunksCheck(ctx),
    createOrphanQdrantCheck(ctx),
    createLatexUpgradeCheck(ctx),
    createFlatSectionPathsCheck(ctx),
    createCoverageGapsCheck(ctx),
    createLicenseBackfillCheck(ctx),
    createStuckPendingCheck(ctx),
    createStuckPendingChunksCheck(ctx),
    createPartialChunksCheck(ctx),
    createCoverageBreakdownDriftCheck(ctx),
  ];
}
