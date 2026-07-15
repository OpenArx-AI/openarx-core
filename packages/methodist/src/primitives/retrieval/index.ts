export * from './search-semantic.js';
export * from './search-shared-source.js';
export * from './read-graph.js';
export * from './fetch-dossier.js';
export * from './fetch-run-state.js';
export * from './fetch-run-path.js';
export * from './fetch-run-closeout.js';

import type { Registration } from '../../runtime/index.js';
import { makeSearchSemantic, type Embed } from './search-semantic.js';
import { searchSharedSourcePrimitive } from './search-shared-source.js';
import { makeReadGraph } from './read-graph.js';
import { fetchDossierPrimitive } from './fetch-dossier.js';
import { fetchRunStatePrimitive } from './fetch-run-state.js';
import { fetchRunPathPrimitive } from './fetch-run-path.js';
import { fetchRunCloseoutPrimitive } from './fetch-run-closeout.js';

/** All retrieval (D) primitives. search-semantic needs an injected query embedder;
 *  read-graph needs the §12.7 record_schemas registry to key its per-type read projection. */
export function retrievalPrimitives(embed: Embed, recordSchemas?: Record<string, unknown>): Registration[] {
  return [
    makeSearchSemantic(embed),
    searchSharedSourcePrimitive,
    makeReadGraph((recordSchemas ?? {}) as Parameters<typeof makeReadGraph>[0]),
    fetchDossierPrimitive,
    fetchRunStatePrimitive,
    fetchRunPathPrimitive,
    fetchRunCloseoutPrimitive,
  ];
}
