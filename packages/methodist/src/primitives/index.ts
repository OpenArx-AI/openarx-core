// Phase 2B — primitive registrations, added wave by wave.
// Wave 1: transform (C). Wave 2: algorithmic (B). Wave 3: retrieval (D).
// Wave 4: state (E). Wave 5: model (A).
export * from './transform/index.js';
export * from './algorithmic/index.js';
export * from './retrieval/index.js';
export * from './state/index.js';
export * from './model/index.js';

import type { Registration } from '../runtime/index.js';
import { transformPrimitives, type AssignId } from './transform/index.js';
import { algorithmicPrimitives, type LangId, type ValidateShape } from './algorithmic/index.js';
import { retrievalPrimitives, type Embed } from './retrieval/index.js';
import { statePrimitives, type MintId, type Clock } from './state/index.js';
import { modelPrimitives } from './model/index.js';

/** Injected capabilities the primitives depend on (wired by integration/tests). */
export interface PrimitiveDeps {
  /** content-derived id allocator (resolve-local-ids) */
  assignId: AssignId;
  /** lang-id model (detect-language) */
  langId: LangId;
  /** query/text embedder (search-semantic, vectorize-and-store) */
  embed: Embed;
  /** run-id source (create-run) */
  mintId: MintId;
  /** clock for dossier deltas (update-dossier) */
  now: Clock;
  /** §12.7 record_schemas registry — keys the per-type read projection (read-graph). */
  recordSchemas?: Record<string, unknown>;
  /** platform per-type MENTEE content-shape validator (validate-schema fail-closed, openarx-xpfz). */
  validateShape?: ValidateShape;
}

/** All ~30 primitives across the 5 categories. */
export function allPrimitives(deps: PrimitiveDeps): Registration[] {
  return [
    ...transformPrimitives(deps.assignId),
    ...algorithmicPrimitives(deps.langId, deps.validateShape),
    ...retrievalPrimitives(deps.embed, deps.recordSchemas),
    ...statePrimitives(
      deps.embed,
      deps.mintId,
      deps.now,
      deps.assignId,
      deps.recordSchemas as Record<string, { vector?: unknown } | undefined> | undefined,
    ),
    ...modelPrimitives(),
  ];
}
