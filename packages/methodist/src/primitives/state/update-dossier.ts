// ── update-dossier v1 (state · deterministic given the clock) ─────────────────
//
// goal: overwrite-in-place the competence map, deriving the delta FROM the verdict
// (§5.4 branch-by-data — the verdict/delta flows in; null field → no-op).
//
// The verdict→dossier-delta MAPPING is methodology-OWNED policy (methodist,
// 2026-07-08). Source of truth for the rules: openarx-methodist
// `design/methodist_v2/methodology.json` → `_meta.confirmed_semantics.update_dossier_mapping`.
// Hardwired here in v1 (one methodology; lift to params on a second). Changing the
// rules = a methodology patch (methods-council), NOT a primitive change.
//
// Mapping (confirmed):
//   autonomy_by_context[cycle]           = verdict.next_dose.autonomy.level, ONLY when the carrier set it
//                                          (professional judgment — NO mechanical GO-increment; illusion-of-learning anti-goal)
//   tier_by_context[creative_element]    = tier_signal.target_tier, when a probe fired (GO or RETURN)
//   passed_units += {unit_id,level,GO,date}  ONLY on GO AND only if the checkpoint carried a unit
//   corrections: RETURN → append {topic,uptake:'not_yet',date}; GO → open ones → uptake:'applied_next_stage'
//   patches_received += verdict.patches   when non-empty
//
// in: { credential_id, verdict, tier_signal?, cycle?, creative_element?, unit_id?, unit_level? }
//   (cycle/creative_element/unit_* are the map KEYS — supplied by the methodology from
//    $runst.cycle / $input.focus / the dose; see the note sent to the methodist.)
// out: { ok } · access: dossier · effects: dossier.

import { definePrimitive, type Registration } from '../../runtime/index.js';

export type Clock = () => string;

interface DossierMap {
  autonomy_by_context: Record<string, unknown>;
  passed_units: unknown[];
  tier_by_context: Record<string, unknown>;
  patches_received: unknown[];
  corrections: Array<{ topic?: unknown; uptake?: string; date?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}
interface Verdict {
  verdict?: 'GO' | 'RETURN';
  next_dose?: { autonomy?: { level?: unknown } } | null;
  corrections?: Array<{ what?: unknown; topic?: unknown }>;
  patches?: unknown[];
}
interface In {
  credential_id: string;
  verdict: Verdict;
  tier_signal?: { target_tier?: unknown };
  cycle?: string;
  creative_element?: string;
  unit_id?: string;
  unit_level?: unknown;
}
interface Out {
  ok: true;
}

function emptyMap(): DossierMap {
  return { autonomy_by_context: {}, passed_units: [], tier_by_context: {}, patches_received: [], corrections: [] };
}

export function makeUpdateDossier(now: Clock): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'update-dossier',
      version: 'v1',
      kind: 'state',
      goal: 'derive and overwrite the competence-map delta from the verdict (methodology policy)',
      access: ['dossier'],
      effects: ['dossier'],
      determinism: 'deterministic',
    },
    async ({ inputs, ctx }) => {
      const cur = ((await ctx.read('dossier').get(inputs.credential_id)) as DossierMap | undefined) ?? emptyMap();
      const next: DossierMap = {
        autonomy_by_context: { ...cur.autonomy_by_context },
        passed_units: [...cur.passed_units],
        tier_by_context: { ...cur.tier_by_context },
        patches_received: [...cur.patches_received],
        corrections: cur.corrections.map((c) => ({ ...c })),
      };
      const v = inputs.verdict.verdict;

      // autonomy — ONLY from the carrier's next_dose.autonomy.level; never mechanical.
      const level = inputs.verdict.next_dose?.autonomy?.level;
      if (level !== undefined && inputs.cycle !== undefined) next.autonomy_by_context[inputs.cycle] = level;

      // tier — on probe fire.
      if (inputs.tier_signal?.target_tier !== undefined && inputs.creative_element !== undefined) {
        next.tier_by_context[inputs.creative_element] = inputs.tier_signal.target_tier;
      }

      // passed_units — GO + a carried unit only.
      if (v === 'GO' && inputs.unit_id !== undefined) {
        next.passed_units.push({ unit_id: inputs.unit_id, level: inputs.unit_level ?? null, verdict: 'GO', date: now() });
      }

      // corrections uptake — RETURN appends not_yet; GO marks open ones applied_next_stage (maturity → fading).
      if (v === 'RETURN') {
        for (const c of inputs.verdict.corrections ?? []) {
          next.corrections.push({ topic: c.what ?? c.topic, uptake: 'not_yet', date: now() });
        }
      } else if (v === 'GO') {
        for (const c of next.corrections) if (c.uptake === 'not_yet') c.uptake = 'applied_next_stage';
      }

      // patches received.
      if (inputs.verdict.patches?.length) next.patches_received.push(...inputs.verdict.patches);

      await ctx.write('dossier').put(inputs.credential_id, next);
      return { outputs: { ok: true } };
    },
  );
}
