// ── apply-supersede-guards v1 (algorithmic · deterministic) ──────────────────
//
// goal: is a supersede (new_ref supersedes old_ref) admissible?
// in: { old_ref, new_ref, owner, old_owner, old_type, new_type, existing_links }
// out: { allowed, violated?[set-once|cycle|ownership|type] } · effects: none.
// existing_links are the current supersedes edges (from supersedes to), passed in
// (composed from read-graph upstream) — the guard logic itself is pure.

import { definePrimitive, type Registration } from '../../runtime/index.js';
import { asRecordArray, type RecordEntry } from '../shared.js';

export interface SupersedeLink {
  /** the newer record */
  from: string;
  /** the record it supersedes */
  to: string;
}
interface In {
  /** checkpoint-publish form: the records to guard (pass-through unless a record
   *  declares `supersedes`; real guards are the supersede-specific form below). */
  records?: unknown;
  old_ref?: string;
  new_ref?: string;
  owner?: string;
  old_owner?: string;
  old_type?: string;
  new_type?: string;
  existing_links?: SupersedeLink[];
}
type Violation = 'set-once' | 'cycle' | 'ownership' | 'type';
interface Out {
  allowed: boolean;
  violated?: Violation[];
  records?: RecordEntry[];
}

/** Can `from` reach `target` following supersedes edges (from → to)? */
function reaches(from: string, target: string, links: SupersedeLink[]): boolean {
  const adj = new Map<string, string[]>();
  for (const l of links) (adj.get(l.from) ?? adj.set(l.from, []).get(l.from)!).push(l.to);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) stack.push(next);
  }
  return false;
}

export const applySupersedeGuardsPrimitive: Registration = definePrimitive<Record<string, never>, In, Out>(
  {
    id: 'apply-supersede-guards',
    version: 'v1',
    kind: 'algorithmic',
    goal: 'check supersede admissibility: set-once / no-cycle / ownership / same-type',
    access: [],
    effects: [],
    determinism: 'deterministic',
  },
  ({ inputs }) => {
    // Checkpoint-publish form: a fresh claim (no `supersedes`) is an allowed
    // pass-through; real guards only apply to the supersede scenario (dormant this
    // wave — gated dedup). The records flow through to write-graph-records.
    if (inputs.records !== undefined) {
      return { outputs: { allowed: true, records: asRecordArray(inputs.records) } };
    }

    // Supersede-specific form: run the guards.
    const links = inputs.existing_links ?? [];
    const violated: Violation[] = [];
    if (links.some((l) => l.to === inputs.old_ref)) violated.push('set-once'); // old already superseded
    if (inputs.old_ref && inputs.new_ref && reaches(inputs.old_ref, inputs.new_ref, links)) violated.push('cycle');
    if (inputs.owner !== inputs.old_owner) violated.push('ownership');
    if (inputs.old_type !== inputs.new_type) violated.push('type');

    return violated.length === 0 ? { outputs: { allowed: true } } : { outputs: { allowed: false, violated } };
  },
);
