// ── Methodology interpreter (frame / layer-1, Phase 2) ───────────────────────
//
// SCHEMA-BLIND and trivial (framework §1 / tz_methodology_schema §exec): walk a
// procedure's linear `steps`, resolve each `in` from slots, call
// primitive(id,version,params,inputs) through the 2A runtime, write `out` to a
// slot, check `gate` (early exit), and build the caller response from `route`.
// NO business logic, NO control-branching, NO runtime schema validation.
//
//   slots:      { input, <step-out>… }
//   source ref: "$input.a.b" | "$<slot>.a.b" | {const: v} | [src…] | {k: src…}
//   gate.when:  a source-ref (truthy) OR {field, op, value} against the step's out
//   outcome:    resolve outcome_from → route key (string, else .verdict, else 'default');
//               a gate overrides with its own outcome.

import { invoke, type RuntimeDeps } from '../runtime/index.js';

export type Source = string | { const: unknown } | Source[] | { [k: string]: Source };
export interface Condition {
  field: string;
  op: 'eq' | 'in' | 'truthy' | 'gt' | 'lt';
  value?: unknown;
}
export interface Step {
  id: string;
  primitive: string;
  version: string;
  params?: Record<string, unknown>;
  in?: Record<string, Source>;
  out?: string;
  gate?: { when: Source | Condition; outcome: string };
  /**
   * dispatch step (§3.1): after this step's primitive runs (route-intent), take its
   * output `route`, map it via `routes` to a procedure name, and execute that named
   * sub-procedure — schema-blind one-level indirection. Terminal (returns the
   * sub-procedure's result). `routes` maps route→procedure-name (identity if omitted).
   */
  dispatch?: { routes?: Record<string, string> };
}
export interface Procedure {
  name: string;
  trigger: { kind: 'endpoint' | 'base_stage'; ref: string };
  steps: Step[];
  outcome_from?: string;
  route: Record<string, Record<string, Source>>;
}
export interface Methodology {
  methodology_version: string;
  prompts?: Record<string, string>;
  schemas?: Record<string, unknown>;
  procedures: Procedure[];
  /** §12.1-bis: methodist-owned run-mechanics VALUES (final_stage_by_cycle,
   *  path_node_shapes) authored in the methodology's `_process` section. Referenced
   *  from a step's params by key via `process_ref` (de-ref'd like record_schema).
   *  Methodology content, NOT frame specs. */
  _process?: Record<string, unknown>;
}

export type Slots = Record<string, unknown>;

function navigate(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Resolve a source ref against the slots. */
export function resolveSource(src: Source, slots: Slots): unknown {
  if (typeof src === 'string') {
    if (src.startsWith('$')) {
      const [head, ...rest] = src.slice(1).split('.');
      return navigate(slots[head], rest);
    }
    return src; // bare string literal
  }
  if (Array.isArray(src)) return src.map((s) => resolveSource(s, slots));
  if (src && typeof src === 'object') {
    if ('const' in src) return (src as { const: unknown }).const;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) out[k] = resolveSource(v as Source, slots);
    return out;
  }
  return src;
}

function resolveInputs(inSpec: Record<string, Source> | undefined, slots: Slots): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inSpec ?? {})) inputs[k] = resolveSource(v, slots);
  return inputs;
}

/** Frame-owned spec registries (Core holds these; the methodology only references
 *  them by key): per-record-type hash-scopes and base schemas. */
export interface FrameSpecs {
  hashScopes?: Record<string, unknown>;
  schemas?: Record<string, unknown>;
  /**
   * record_schemas registry (Phase 0.2 / §12.7): per-record-type schema VALUES the
   * graph/vector/read adapters consume — field allow-lists, the {{field}} embed
   * projection, payload set, read strip/pointer. Methodist-owned VALUES, Core-owned
   * format. Referenced from a step via `params.record_schema: "<key>"` (de-ref'd
   * like hash_scope). NOTE: identity hash-scopes stay in `hashScopes` (Contracts /
   * §4.3), NOT in this registry.
   */
  recordSchemas?: Record<string, unknown>;
}

/** params are static; prompt/template/output_schema de-reference the METHODOLOGY's
 *  prompts/schemas; hash_scope/schema_ref de-reference the FRAME specs. */
function resolveParams(
  params: Record<string, unknown> | undefined,
  m: Methodology,
  frame: FrameSpecs | undefined,
): Record<string, unknown> {
  if (!params) return {};
  const out = { ...params };
  for (const key of ['prompt', 'template'] as const) {
    if (typeof out[key] === 'string' && m.prompts && out[key]! in m.prompts) out[key] = m.prompts[out[key] as string];
  }
  if (typeof out.output_schema === 'string' && m.schemas && (out.output_schema as string) in m.schemas) {
    out.output_schema = m.schemas[out.output_schema as string];
  }
  const hs = frame?.hashScopes ?? {};
  if (typeof out.hash_scope === 'string' && (out.hash_scope as string) in hs) out.hash_scope = hs[out.hash_scope as string];
  const sc = frame?.schemas ?? {};
  if (typeof out.schema_ref === 'string' && (out.schema_ref as string) in sc) {
    out.base_schema = sc[out.schema_ref as string];
    delete out.schema_ref;
  }
  // Phase 0.2 / §12.7: a `record_schema` key de-references the frame's record_schemas
  // registry (per-record-type adapter schema), in place. No-op until the registry
  // is populated and an adapter step references it.
  const rs = frame?.recordSchemas ?? {};
  if (typeof out.record_schema === 'string' && (out.record_schema as string) in rs) {
    out.record_schema = rs[out.record_schema as string];
  }
  // §12.1-bis: a `process_ref` key de-references the methodology's `_process` section
  // (methodist run-mechanics values, e.g. final_stage_by_cycle) into a param of the
  // SAME name. Consistent with record_schema/hash_scope — the KEY triggers, the VALUE is
  // the lookup key. e.g. { process_ref: "final_stage_by_cycle" } → params.final_stage_by_cycle.
  const proc = m._process ?? {};
  if (typeof out.process_ref === 'string' && (out.process_ref as string) in proc) {
    out[out.process_ref as string] = proc[out.process_ref as string];
    delete out.process_ref;
  }
  return out;
}

function evalGate(when: Source | Condition, slots: Slots, outValue: unknown): boolean {
  // Condition object {field, op, value} evaluated against the step's out value.
  if (when && typeof when === 'object' && !Array.isArray(when) && 'op' in when) {
    const c = when as Condition;
    const v = navigate(outValue, c.field.split('.'));
    switch (c.op) {
      case 'truthy':
        return Boolean(v);
      case 'eq':
        return v === c.value;
      case 'in':
        return Array.isArray(c.value) && c.value.includes(v);
      case 'gt':
        return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
      case 'lt':
        return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
      default:
        return false;
    }
  }
  // source-ref form (methodist v2): resolve + truthy.
  return Boolean(resolveSource(when as Source, slots));
}

function buildProjection(proj: Record<string, Source> | undefined, slots: Slots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(proj ?? {})) out[k] = resolveSource(v, slots);
  return out;
}

function terminalKey(outcomeFrom: string | undefined, slots: Slots, route: Procedure['route']): string {
  if (!outcomeFrom) return 'default' in route ? 'default' : 'ok';
  const ref = outcomeFrom.startsWith('$') ? outcomeFrom : `$${outcomeFrom}`;
  const val = resolveSource(ref, slots);
  if (typeof val === 'string' && val in route) return val;
  if (val && typeof val === 'object' && typeof (val as Record<string, unknown>).verdict === 'string') {
    const k = (val as { verdict: string }).verdict;
    if (k in route) return k;
  }
  return 'default' in route ? 'default' : 'ok';
}

export interface InterpreterDeps {
  runtime: RuntimeDeps;
  methodology: Methodology;
  /** frame-held spec registries (hash-scopes / base schemas), referenced by key. */
  frameSpecs?: FrameSpecs;
}

export interface ProcedureResult {
  outcome: string;
  response: Record<string, unknown>;
  /** every step's output slot, keyed by `out`/`id` — for observability/dumps (additive). */
  slots: Slots;
}

/** Execute the procedure bound to `endpointRef` with the call `input`. */
export async function runEndpoint(
  deps: InterpreterDeps,
  endpointRef: string,
  input: Record<string, unknown>,
): Promise<ProcedureResult> {
  const proc = deps.methodology.procedures.find((p) => p.trigger.kind === 'endpoint' && p.trigger.ref === endpointRef);
  if (!proc) throw new Error(`no procedure bound to endpoint '${endpointRef}'`);
  return runProcedure(deps, proc, input, 0);
}

/** Dispatch indirection is one-level (§3.1); the cap is a runaway guard, not a feature. */
const MAX_DISPATCH_DEPTH = 4;

/** Walk a procedure's linear steps against a fresh blackboard seeded with `input`. */
async function runProcedure(
  deps: InterpreterDeps,
  proc: Procedure,
  input: Record<string, unknown>,
  depth: number,
): Promise<ProcedureResult> {
  const slots: Slots = { input };
  for (const step of proc.steps) {
    const params = resolveParams(step.params, deps.methodology, deps.frameSpecs);
    const inputs = resolveInputs(step.in, slots);
    // A run is stamped with the methodology VERSION it runs under — a config value, not a
    // runtime input. create-run reads inputs.methodology_version, but the diagnose wiring binds
    // only credential_id/parent_run_id, so without this the stamp was always null (methodist
    // bug: null_ver on every run → no per-version metrics slice, eied version-propagation had a
    // null source). Thread it from the loaded methodology config at run-birth. Fill-only: an
    // explicit `in.methodology_version` binding, if ever added, still wins.
    if (step.primitive === 'create-run' && inputs.methodology_version == null) {
      inputs.methodology_version = deps.methodology.methodology_version;
    }
    // Identity is FRAME-owned (§1-bis) — the methodology never binds it. Thread the runtime
    // credential (= the §4.3 id prefix AND the attester) from the endpoint input into
    // resolve-local-ids, so a bundle-local ref resolves to the SAME §4.3 id that write-graph-records
    // will assign to the claim. Without it (val3) the prefix was 'undefined' and the ref never
    // matched its claim → no provenance edge. Fill-only.
    if (step.primitive === 'resolve-local-ids' && inputs.sourcePrefix == null) {
      inputs.sourcePrefix = (input as { agent_id?: unknown }).agent_id;
    }
    const outcome = await invoke(deps.runtime, { id: step.primitive, version: step.version, params, inputs });

    const outValue = outcome.status === 'ok' || outcome.status === 'returned' ? outcome.outputs : { error: outcome.error };
    slots[step.out ?? step.id] = outValue;

    // dispatch (§3.1): this step's primitive (route-intent) yielded a `route`; execute the
    // named sub-procedure `routes[route]` against a FRESH blackboard seeded with the SAME
    // door `input`, and return its result. Schema-blind one-level indirection — the
    // interpreter dispatches by name and never interprets the route's semantics.
    if (step.dispatch) {
      if (depth >= MAX_DISPATCH_DEPTH) throw new Error(`dispatch depth exceeded (${MAX_DISPATCH_DEPTH})`);
      const route = outValue && typeof outValue === 'object' ? (outValue as { route?: unknown }).route : undefined;
      const routes = step.dispatch.routes ?? {};
      const subName = typeof route === 'string' ? (routes[route] ?? route) : undefined;
      const subProc = subName ? deps.methodology.procedures.find((p) => p.name === subName) : undefined;
      if (!subProc) throw new Error(`dispatch: no procedure for route '${String(route)}' (resolved '${String(subName)}')`);
      return runProcedure(deps, subProc, input, depth + 1);
    }

    if (step.gate && evalGate(step.gate.when, slots, outValue)) {
      return { outcome: step.gate.outcome, response: buildProjection(proc.route[step.gate.outcome], slots), slots };
    }
    // An uncaught contract violation aborts the procedure (§6 rejected).
    if (outcome.status === 'rejected') {
      const key = 'error' in proc.route ? 'error' : 'rejected';
      // observability (openarx-b783): a bare {outcome:'rejected'} left the mentee AND the curator
      // BLIND — no WHY (the reject reason lived only in outcome.error, never surfaced; the checkpoint
      // route has no 'error'/'rejected' projection). Attach the rejected step's reason + reason_code
      // + which step failed, so every reject is self-diagnosable (mirrors RETURN carrying reasons).
      const projection = (buildProjection(proc.route[key], slots) ?? {}) as Record<string, unknown>;
      return {
        outcome: key,
        response: { ...projection, reason: outcome.error.message, reason_code: outcome.error.code, rejected_at: step.id },
        slots,
      };
    }
  }

  const key = terminalKey(proc.outcome_from, slots, proc.route);
  return { outcome: key, response: buildProjection(proc.route[key], slots), slots };
}
