// ── create-run v1 (state · deterministic given the id source) ────────────────
//
// goal: birth a run object (first-class graph node, §12.1). Wave-v2 form (converged
// with methodist 2026-07-08): MINTS run_id (interpreter no longer supplies it),
// keyed by credential_id (the mentee identity — reference, not a graph node).
// in: { credential_id, parent_run_id?, methodology_version? } · out: { run_id }
// access: run-state (parent check) · effects: run-state.
// cycle/current_stage/dose are set later by update-run-state (from diagnose).
// The id source is INJECTED (like the embedder) so tests are deterministic and
// integration wires a real generator.

import { definePrimitive, RuntimeError, type Registration } from '../../runtime/index.js';

export type MintId = (credentialId: string) => string;

interface In {
  credential_id: string;
  parent_run_id?: string;
  methodology_version?: string;
}
interface Out {
  run_id: string;
}

export function makeCreateRun(mintId: MintId): Registration {
  return definePrimitive<Record<string, never>, In, Out>(
    {
      id: 'create-run',
      version: 'v1',
      kind: 'state',
      goal: 'mint an active run node keyed by credential, linking optional parent',
      access: ['run-state'],
      effects: ['run-state'],
      determinism: 'deterministic',
    },
    async ({ inputs, ctx }) => {
      // null AND undefined both mean "no parent" (the interpreter passes null for an absent $input field).
      if (inputs.parent_run_id != null && (await ctx.read('run-state').get(inputs.parent_run_id)) === undefined) {
        throw new RuntimeError('bad-output', `parent run '${inputs.parent_run_id}' does not exist`);
      }
      const run_id = mintId(inputs.credential_id);
      await ctx.write('run-state').put(run_id, {
        run_id,
        credential_id: inputs.credential_id,
        parent_run_id: inputs.parent_run_id ?? null,
        methodology_version: inputs.methodology_version ?? null,
        cycle: null,
        current_stage: null,
        go_marks: [],
        status: 'active',
        dose: null,
      });
      return { outputs: { run_id } };
    },
  );
}
