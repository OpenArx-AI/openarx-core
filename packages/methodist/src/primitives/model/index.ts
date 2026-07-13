export * from './prepare-context.js';
export * from './call-model.js';

import type { Registration } from '../../runtime/index.js';
import { prepareContextPrimitive } from './prepare-context.js';
import { callModelPrimitive } from './call-model.js';

/** All model (A) primitives. call-model's client is injected at invoke time (deps.model). */
export function modelPrimitives(): Registration[] {
  return [prepareContextPrimitive, callModelPrimitive];
}
