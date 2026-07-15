import { describe, expect, it } from 'vitest';
import { deriveRunStatusPrimitive } from '../src/index.js';

const run = (params: unknown, inputs: unknown): string =>
  (deriveRunStatusPrimitive.impl({ params, inputs, ctx: {} as never }) as { outputs: { status: string } }).outputs.status;

describe('derive-run-status (§12.1-bis / §12.1 finalization)', () => {
  it('done: the run is finalized (a version_closeout exists → finalized=true)', () => {
    expect(run({}, { finalized: true, path_events: [{ type: 'dose_issued', ts: '1' }, { type: 'checkpoint_go', stage: 6, ts: '2' }] })).toBe('done');
  });

  it('NOT done when not finalized, regardless of how far the run advanced', () => {
    // reaching a final-looking stage is NO LONGER done — only a durable version_closeout is.
    expect(run({}, { finalized: false, path_events: [{ type: 'checkpoint_go', stage: 6, ts: '1' }] })).toBe('active');
  });

  it('NOT done when finalized is absent (fetch-run-closeout returned nothing / not wired)', () => {
    expect(run({}, { path_events: [{ type: 'checkpoint_go', stage: 6, ts: '1' }] })).toBe('active');
  });

  it('paused: the last path-event is report_need', () => {
    expect(run({}, { finalized: false, path_events: [{ type: 'checkpoint_go', stage: 2, ts: '1' }, { type: 'report_need', ts: '2' }] })).toBe('paused');
  });

  it('done (finalized) takes precedence over a trailing report_need', () => {
    expect(run({}, { finalized: true, path_events: [{ type: 'checkpoint_go', stage: 6, ts: '1' }, { type: 'report_need', ts: '2' }] })).toBe('done');
  });

  it('abandoned: stale beyond the threshold', () => {
    expect(run({ abandon_threshold_ms: 1000 }, { finalized: false, now: '2026-07-10T00:00:10Z', path_events: [{ type: 'dose_issued', stage: 1, ts: '2026-07-10T00:00:00Z' }] })).toBe('abandoned');
  });

  it('finalized wins over staleness (a finalized run is never abandoned)', () => {
    expect(run({ abandon_threshold_ms: 1000 }, { finalized: true, now: '2026-07-10T00:00:10Z', path_events: [{ type: 'dose_issued', stage: 1, ts: '2026-07-10T00:00:00Z' }] })).toBe('done');
  });

  it('active: recent, not finalized, not paused', () => {
    expect(run({ abandon_threshold_ms: 100000 }, { finalized: false, now: '2026-07-10T00:00:10Z', path_events: [{ type: 'dose_issued', stage: 1, ts: '2026-07-10T00:00:05Z' }] })).toBe('active');
  });

  it('active when now is absent (no abandoned check) and for an empty path', () => {
    expect(run({}, { finalized: false, path_events: [{ type: 'dose_issued', stage: 1, ts: 'x' }] })).toBe('active');
    expect(run({}, { finalized: false, path_events: [] })).toBe('active');
  });

  it('resume: a new event after a report_need re-derives to active', () => {
    expect(run({}, { finalized: false, path_events: [{ type: 'report_need', ts: '1' }, { type: 'dose_issued', stage: 2, ts: '2' }] })).toBe('active');
  });
});
