// ── Wave v2 dossier-store (layer_2_pillar.md §12.2, methodist_framework_v2.md §7) ─
//
// Rebuilt relational store replacing the 044/045 dossier ROLE. Two concerns:
//   - `credential` — the agent identity (credential_id); the graph references it as
//     a property of the `run` node, never as a graph node (Vlad D3).
//   - `dossier` — a FLAT, overwritten-in-place competence map fed to the model:
//     autonomy_by_context (PER-CYCLE — NOT an A0/A1/A2 ladder), passed_units,
//     tier_by_context (§7 tier-gate), patches_received, corrections.
//
// The journal is immutable and NEVER fed to the model (§12.2) — it is NOT here; it
// lives as immutable activity nodes in the graph. This module holds only the map.

import { query } from '../db/pool.js';

export interface Dossier {
  credential_id: string;
  /** per-cycle autonomy map (NOT a ladder) — keyed by cycle/context */
  autonomy_by_context: Record<string, unknown>;
  passed_units: unknown[];
  /** methodology tier per model capability (§7 tier-gate) */
  tier_by_context: Record<string, unknown>;
  patches_received: unknown[];
  corrections: unknown[];
  updated_at: string;
}

/** Fields a caller may overwrite in place; omitted fields are left unchanged. */
export interface DossierPatch {
  autonomy_by_context?: Record<string, unknown>;
  passed_units?: unknown[];
  tier_by_context?: Record<string, unknown>;
  patches_received?: unknown[];
  corrections?: unknown[];
}

/** Read a dossier map; null if none yet. */
export async function getDossier(credentialId: string): Promise<Dossier | null> {
  const r = await query<Dossier>(
    `SELECT credential_id, autonomy_by_context, passed_units, tier_by_context,
            patches_received, corrections, updated_at::text
       FROM dossier WHERE credential_id = $1`,
    [credentialId],
  );
  return r.rows[0] ?? null;
}

/**
 * Overwrite-in-place: provided fields REPLACE their column; omitted fields are
 * kept (COALESCE against the existing row). Creates the row on first write.
 */
export async function upsertDossier(credentialId: string, patch: DossierPatch): Promise<Dossier> {
  const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const r = await query<Dossier>(
    `INSERT INTO dossier (credential_id, autonomy_by_context, passed_units, tier_by_context, patches_received, corrections)
     VALUES ($1,
             COALESCE($2::jsonb, '{}'::jsonb),
             COALESCE($3::jsonb, '[]'::jsonb),
             COALESCE($4::jsonb, '{}'::jsonb),
             COALESCE($5::jsonb, '[]'::jsonb),
             COALESCE($6::jsonb, '[]'::jsonb))
     ON CONFLICT (credential_id) DO UPDATE SET
       autonomy_by_context = COALESCE($2::jsonb, dossier.autonomy_by_context),
       passed_units        = COALESCE($3::jsonb, dossier.passed_units),
       tier_by_context     = COALESCE($4::jsonb, dossier.tier_by_context),
       patches_received    = COALESCE($5::jsonb, dossier.patches_received),
       corrections         = COALESCE($6::jsonb, dossier.corrections),
       updated_at = now()
     RETURNING credential_id, autonomy_by_context, passed_units, tier_by_context,
               patches_received, corrections, updated_at::text`,
    [
      credentialId,
      j(patch.autonomy_by_context),
      j(patch.passed_units),
      j(patch.tier_by_context),
      j(patch.patches_received),
      j(patch.corrections),
    ],
  );
  return r.rows[0]!;
}
