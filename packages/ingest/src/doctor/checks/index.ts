/**
 * Check module registry — add new checks here.
 *
 * Removed with the registry-driven coverage transition (openarx-j173,
 * approved by Vlad 2026-06-11): coverage-gaps and coverage-breakdown-drift
 * read coverage_map aggregates — superseded by registry-gaps, which reports
 * concrete documents from the per-document registry.
 */

import type { CheckModule, DoctorContext } from '../types.js';
import { createMissingQdrantCheck } from './missing-qdrant-chunks.js';
import { createOversizedChunksCheck } from './oversized-chunks.js';
import { createOrphanQdrantCheck } from './orphan-qdrant-points.js';
import { createLatexUpgradeCheck } from './latex-upgrade.js';
import { createFlatSectionPathsCheck } from './flat-section-paths.js';
import { createLicenseBackfillCheck } from './license-backfill.js';
import { createStuckPendingCheck } from './stuck-pending.js';
import { createStuckPendingChunksCheck } from './stuck-pending-chunks.js';
import { createPartialChunksCheck } from './partial-chunks.js';
import { createRegistryGapsCheck } from './registry-gaps.js';

export function getAllChecks(ctx: DoctorContext): CheckModule[] {
  return [
    createMissingQdrantCheck(ctx),
    createOversizedChunksCheck(ctx),
    createOrphanQdrantCheck(ctx),
    createLatexUpgradeCheck(ctx),
    createFlatSectionPathsCheck(ctx),
    createRegistryGapsCheck(ctx),
    createLicenseBackfillCheck(ctx),
    createStuckPendingCheck(ctx),
    createStuckPendingChunksCheck(ctx),
    createPartialChunksCheck(ctx),
  ];
}
