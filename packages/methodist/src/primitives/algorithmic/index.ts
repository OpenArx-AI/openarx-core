export * from './check-stop-rule.js';
export * from './check-idempotency.js';
export * from './validate-schema.js';
export * from './detect-language.js';
export * from './crosscheck-tool-usage.js';
export * from './classify-convergence.js';
export * from './threshold-zone.js';
export * from './select-canonical.js';
export * from './apply-supersede-guards.js';
export * from './compute-superseded-by.js';
export * from './filter-latest-only.js';
export * from './route-intent.js';
export * from './derive-run-status.js';

import type { Registration } from '../../runtime/index.js';
import { checkStopRulePrimitive } from './check-stop-rule.js';
import { checkIdempotencyPrimitive } from './check-idempotency.js';
import { makeValidateSchema, type ValidateShape } from './validate-schema.js';
import { makeDetectLanguage, type LangId } from './detect-language.js';
import { crosscheckToolUsagePrimitive } from './crosscheck-tool-usage.js';
import { classifyConvergencePrimitive } from './classify-convergence.js';
import { thresholdZonePrimitive } from './threshold-zone.js';
import { selectCanonicalPrimitive } from './select-canonical.js';
import { applySupersedeGuardsPrimitive } from './apply-supersede-guards.js';
import { computeSupersededByPrimitive } from './compute-superseded-by.js';
import { filterLatestOnlyPrimitive } from './filter-latest-only.js';
import { routeIntentPrimitive } from './route-intent.js';
import { deriveRunStatusPrimitive } from './derive-run-status.js';

/** All algorithmic (B) primitives. detect-language needs an injected lang-id; validate-schema
 *  takes an optional platform shape-validator (fail-closed record well-formedness, openarx-xpfz). */
export function algorithmicPrimitives(langId: LangId, validateShape?: ValidateShape): Registration[] {
  return [
    checkStopRulePrimitive,
    routeIntentPrimitive,
    deriveRunStatusPrimitive,
    checkIdempotencyPrimitive,
    makeValidateSchema(validateShape),
    makeDetectLanguage(langId),
    crosscheckToolUsagePrimitive,
    classifyConvergencePrimitive,
    thresholdZonePrimitive,
    selectCanonicalPrimitive,
    applySupersedeGuardsPrimitive,
    computeSupersededByPrimitive,
    filterLatestOnlyPrimitive,
  ];
}
