import { describe, expect, it } from 'vitest';
import { routeIntentPrimitive } from '../src/index.js';

// route-intent is a pure, sync, pre-model primitive (no ctx access).
const run = (params: unknown, inputs: unknown): string =>
  (routeIntentPrimitive.impl({ params, inputs, ctx: {} as never }) as { outputs: { route: string } }).outputs.route;

const sig = { publish_signal: [{ field: 'submission_hash' }] };

describe('route-intent (§3.1)', () => {
  it('no active run → diagnose', () => {
    expect(run({}, { payload: {} })).toBe('diagnose');
    expect(run(sig, { run_state: null, payload: { submission_hash: 'h' } })).toBe('diagnose');
  });

  it('active run + explicit publish-signal → checkpoint', () => {
    expect(run(sig, { run_state: { status: 'active' }, payload: { submission_hash: 'h1' } })).toBe('checkpoint');
  });

  it('active run + no signal → ask', () => {
    expect(run(sig, { run_state: { status: 'active' }, payload: { question: 'x' } })).toBe('ask');
  });

  it('publish-safety: an absent/empty signal spec never routes to checkpoint', () => {
    expect(run({}, { run_state: { status: 'active' }, payload: { submission_hash: 'h' } })).toBe('ask');
    expect(run({ publish_signal: [] }, { run_state: { status: 'active' }, payload: { submission_hash: 'h' } })).toBe('ask');
  });

  it('F1: a blank / whitespace-only string signal is NOT deliberative → ask, not checkpoint', () => {
    expect(run(sig, { run_state: { status: 'active' }, payload: { submission_hash: '' } })).toBe('ask');
    expect(run(sig, { run_state: { status: 'active' }, payload: { submission_hash: '   ' } })).toBe('ask');
  });

  it('equals-form signal matches strictly', () => {
    const eq = { publish_signal: [{ field: 'action', equals: 'checkpoint' }] };
    expect(run(eq, { run_state: { status: 'active' }, payload: { action: 'checkpoint' } })).toBe('checkpoint');
    expect(run(eq, { run_state: { status: 'active' }, payload: { action: 'other' } })).toBe('ask');
  });

  it('route_names override the default route names', () => {
    expect(run({ route_names: { no_run: 'diag2' } }, { payload: {} })).toBe('diag2');
  });

  it('regression (openarx-tester-279): {} or {error} run_state for a new agent → diagnose, NOT ask', () => {
    // The single door fetches run-state BEFORE routing; for a new agent (no run_id) that
    // fetch yields an empty object or an error slot — a non-null object that the prior
    // `typeof === 'object'` check mis-read as an active run and routed to ask. Both must
    // route to diagnose (start a run).
    expect(run(sig, { run_state: {}, payload: { intent: 'measure X' } })).toBe('diagnose');
    expect(run(sig, { run_state: { error: { code: 'internal' } }, payload: { intent: 'measure X' } })).toBe('diagnose');
    // a REAL run object (carries run identity) is still active → ask
    expect(run(sig, { run_state: { run_id: 'r1', current_stage: 2, status: 'active' }, payload: { question: 'q' } })).toBe('ask');
  });
});
