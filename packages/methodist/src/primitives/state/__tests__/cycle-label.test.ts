import { test, expect } from 'vitest';
import { normalizeCycle, VALID_CYCLES, CYCLE_NAME_BY_NUMBER } from '../cycle-label.js';

// The authoritative §12.1 mapping (contracts oyq) + the exact legacy forms the back-fill sees.
test('numbers and numeric strings → {cycle, name} by the table', () => {
  expect(normalizeCycle(3)).toEqual({ cycle: 3, cycle_name: 'Synthesis' });
  expect(normalizeCycle('3')).toEqual({ cycle: 3, cycle_name: 'Synthesis' });
  expect(normalizeCycle('4')).toEqual({ cycle: 4, cycle_name: 'Methodology' });
  expect(normalizeCycle('8')).toEqual({ cycle: 8, cycle_name: 'Engineering' });
});

test('an integer input stays a JS integer (type-lock: JCS sees 9, not "9")', () => {
  const r = normalizeCycle(9);
  expect(r).not.toBeNull();
  expect(typeof r!.cycle).toBe('number');
  expect(Number.isInteger(r!.cycle)).toBe(true);
  expect(r!.cycle).toBe(9);
});

test('prefixed legacy names → number by the embedded cycle digit (canonical name from table)', () => {
  expect(normalizeCycle('Cycle 1: Discovery')).toEqual({ cycle: 1, cycle_name: 'Discovery' });
  expect(normalizeCycle('Cycle 2 - Verification')).toEqual({ cycle: 2, cycle_name: 'Verification' });
  expect(normalizeCycle('Cycle 5: Dispute-mapping')).toEqual({ cycle: 5, cycle_name: 'Dispute-Mapping' });
  expect(normalizeCycle('Cycle 6: Agenda')).toEqual({ cycle: 6, cycle_name: 'Agenda' });
});

test('bare canonical name (no cycle prefix) → number by name match', () => {
  expect(normalizeCycle('Review/Integration')).toEqual({ cycle: 9, cycle_name: 'Review/Integration' });
  expect(normalizeCycle('engineering')).toEqual({ cycle: 8, cycle_name: 'Engineering' });
});

test('★ 7 is RESERVED → null (never a valid cycle; a 7 is a bug to report)', () => {
  expect(normalizeCycle(7)).toBeNull();
  expect(normalizeCycle('7')).toBeNull();
  expect(VALID_CYCLES.has(7)).toBe(false);
  expect(7 in CYCLE_NAME_BY_NUMBER).toBe(false);
});

test('unmappable / out-of-range / junk → null (caller reports, never guesses)', () => {
  expect(normalizeCycle('0')).toBeNull();
  expect(normalizeCycle('10')).toBeNull();
  expect(normalizeCycle('some free text with no cycle')).toBeNull();
  expect(normalizeCycle('')).toBeNull();
  expect(normalizeCycle(null)).toBeNull();
  expect(normalizeCycle(undefined)).toBeNull();
  expect(normalizeCycle({})).toBeNull();
});

test('valid set is exactly {1,2,3,4,5,6,8,9}', () => {
  expect([...VALID_CYCLES].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
});
