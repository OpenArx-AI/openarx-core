// ── link-supersedes v1 (state · deterministic) ───────────────────────────────
//
// goal: create a supersede edge (after the guards) + set the pointers.
// in: { old_ref, new_ref, reason, guard_result }, params: { link_id }
// out: { link_id } · access: graph · effects: graph (supersedes edge + superseded_by/latest).
// If the guards did NOT allow the supersede, nothing is written → returned.

import { definePrimitive, type Registration } from '../../runtime/index.js';

interface In {
  old_ref: string;
  new_ref: string;
  reason: 'erratum' | 'refinement' | 'same_as';
  guard_result: { allowed: boolean };
}
interface Params {
  link_id: string;
}
interface Out {
  link_id: string | null;
}

export const linkSupersedesPrimitive: Registration = definePrimitive<Params, In, Out>(
  {
    id: 'link-supersedes',
    version: 'v1',
    kind: 'state',
    goal: 'create a supersede edge and set superseded_by/latest pointers',
    access: ['graph'],
    effects: ['graph'],
    determinism: 'deterministic',
  },
  async ({ inputs, params, ctx }) => {
    if (!inputs.guard_result.allowed) {
      return { control: 'returned', outputs: { link_id: null } };
    }
    const write = ctx.write('graph');
    await write.put(params.link_id, {
      link_id: params.link_id,
      type: 'supersedes',
      from: inputs.new_ref,
      to: inputs.old_ref,
      reason: inputs.reason,
    });
    await write.put(`superseded_by:${inputs.old_ref}`, inputs.new_ref);
    await write.put(`latest:${inputs.old_ref}`, inputs.new_ref);
    return { outputs: { link_id: params.link_id } };
  },
);
