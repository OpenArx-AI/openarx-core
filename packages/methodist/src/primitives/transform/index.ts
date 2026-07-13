export * from './hash-scope.js';
export * from './canonicalize.js';
export * from './compute-hash.js';
export * from './resolve-local-ids.js';

import type { Registration } from '../../runtime/index.js';
import { canonicalizePrimitive } from './canonicalize.js';
import { computeHashPrimitive } from './compute-hash.js';
import { makeResolveLocalIds, type AssignId } from './resolve-local-ids.js';

/** All transform (C) primitives. resolve-local-ids needs an injected id allocator. */
export function transformPrimitives(assignId: AssignId): Registration[] {
  return [canonicalizePrimitive, computeHashPrimitive, makeResolveLocalIds(assignId)];
}
