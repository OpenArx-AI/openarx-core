export * from './create-run.js';
export * from './update-run-state.js';
export * from './update-dossier.js';
export * from './append-journal.js';
export * from './write-graph-records.js';
export * from './commit-bundle-atomic.js';
export * from './vectorize-and-store.js';
export * from './link-supersedes.js';
export * from './create-corrective-activity.js';

import type { Registration } from '../../runtime/index.js';
import type { Embed } from '../retrieval/search-semantic.js';
import type { AssignId } from '../transform/resolve-local-ids.js';
import { makeCreateRun, type MintId } from './create-run.js';
import { updateRunStatePrimitive } from './update-run-state.js';
import { makeUpdateDossier, type Clock } from './update-dossier.js';
import { appendJournalPrimitive } from './append-journal.js';
import { makeWriteGraphRecords } from './write-graph-records.js';
import { commitBundleAtomicPrimitive } from './commit-bundle-atomic.js';
import { makeVectorizeAndStore } from './vectorize-and-store.js';
import { linkSupersedesPrimitive } from './link-supersedes.js';
import { createCorrectiveActivityPrimitive } from './create-corrective-activity.js';

/** All state (E) primitives. create-run needs an id source; update-dossier +
 *  write-graph-records a clock; write-graph-records + create-run an id allocator;
 *  vectorize-and-store an embedder + the record_schemas (§12.7 vector blocks). */
export function statePrimitives(
  embed: Embed,
  mintId: MintId,
  now: Clock,
  assignId: AssignId,
  recordSchemas: Record<string, { vector?: unknown } | undefined> = {},
): Registration[] {
  return [
    makeCreateRun(mintId),
    updateRunStatePrimitive,
    makeUpdateDossier(now),
    appendJournalPrimitive,
    makeWriteGraphRecords(assignId, now),
    commitBundleAtomicPrimitive,
    makeVectorizeAndStore(embed, recordSchemas as Record<string, { vector?: import('../../adapters/embed.js').VectorSchema } | undefined>),
    linkSupersedesPrimitive,
    createCorrectiveActivityPrimitive,
  ];
}
