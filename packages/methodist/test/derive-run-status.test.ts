import { describe, expect, it } from 'vitest';
import { deriveRunStatusPrimitive } from '../src/index.js';

const run = (params: unknown, inputs: unknown): string =>
  (deriveRunStatusPrimitive.impl({ params, inputs, ctx: {} as never }) as { outputs: { status: string } }).outputs.status;

const finals = { final_stage_by_cycle: { c1: 6, c2: 8 } };

describe('derive-run-status (§12.1-bis)', () => {
  it('done: a checkpoint_go at the cycle final stage', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'dose_issued', ts: '1' }, { type: 'checkpoint_go', stage: 6, ts: '2' }] })).toBe('done');
  });

  it('NOT done when the checkpoint_go is at a non-final stage', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'checkpoint_go', stage: 3, ts: '1' }] })).toBe('active');
  });

  it('NOT done when the cycle has no final_stage (c7-reserved / catch-all falls through)', () => {
    expect(run(finals, { cycle: 'c7', path_events: [{ type: 'checkpoint_go', stage: 6, ts: '1' }] })).toBe('active');
  });

  it('paused: the last path-event is report_need', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'checkpoint_go', stage: 2, ts: '1' }, { type: 'report_need', ts: '2' }] })).toBe('paused');
  });

  it('done takes precedence over a trailing report_need', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'checkpoint_go', stage: 6, ts: '1' }, { type: 'report_need', ts: '2' }] })).toBe('done');
  });

  it('abandoned: stale beyond the threshold', () => {
    expect(run({ ...finals, abandon_threshold_ms: 1000 }, { cycle: 'c1', now: '2026-07-10T00:00:10Z', path_events: [{ type: 'dose_issued', stage: 1, ts: '2026-07-10T00:00:00Z' }] })).toBe('abandoned');
  });

  it('active: recent, not done, not paused', () => {
    expect(run({ ...finals, abandon_threshold_ms: 100000 }, { cycle: 'c1', now: '2026-07-10T00:00:10Z', path_events: [{ type: 'dose_issued', stage: 1, ts: '2026-07-10T00:00:05Z' }] })).toBe('active');
  });

  it('active when now is absent (no abandoned check) and for an empty path', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'dose_issued', stage: 1, ts: 'x' }] })).toBe('active');
    expect(run(finals, { cycle: 'c1', path_events: [] })).toBe('active');
  });

  it('resume: a new event after a report_need re-derives to active', () => {
    expect(run(finals, { cycle: 'c1', path_events: [{ type: 'report_need', ts: '1' }, { type: 'dose_issued', stage: 2, ts: '2' }] })).toBe('active');
  });
});
