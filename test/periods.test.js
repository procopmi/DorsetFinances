// Tests for report date ranges. Run with: npm test
//
// A wrong range means a report quietly leaves out (or double counts) money,
// so the month ends, year ends and leap years are checked here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthRange, presetRange, PRESETS, todayText, monthsBetween, monthWithin } from '../src/periods.js';

test('a month runs from its first to its last day, leap years included', () => {
  assert.deepEqual(monthRange('2026-01'), { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(monthRange('2026-04'), { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
});

test('presets in the middle of a year', () => {
  const today = '2026-10-21';
  assert.deepEqual(presetRange('this-month', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('last-month', today), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('ytd', today), { from: '2026-01-01', to: '2026-10-21' });
  assert.deepEqual(presetRange('last-12', today), { from: '2025-11-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('last-year', today), { from: '2025-01-01', to: '2025-12-31' });
});

test('presets in January cross back into last year', () => {
  const today = '2026-01-05';
  assert.deepEqual(presetRange('last-month', today), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(presetRange('last-12', today), { from: '2025-02-01', to: '2026-01-31' });
  assert.deepEqual(presetRange('ytd', today), { from: '2026-01-01', to: '2026-01-05' });
});

test('last month from March in a leap year ends on 29 February', () => {
  assert.deepEqual(presetRange('last-month', '2028-03-31'), { from: '2028-02-01', to: '2028-02-29' });
});

test('every preset gives a range whose start is not after its end', () => {
  for (const preset of PRESETS) {
    const { from, to } = presetRange(preset, '2026-12-31');
    assert.ok(from <= to, preset);
  }
  assert.throws(() => presetRange('fortnight', '2026-10-21'));
});

test('today is the local date, zero-padded', () => {
  assert.equal(todayText(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('months between two dates include partial first and last months, across a year end', () => {
  assert.deepEqual(monthsBetween('2025-11-15', '2026-02-03'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-03-01', '2026-03-31'), ['2026-03']);
  assert.deepEqual(monthsBetween('2026-03-31', '2026-04-01'), ['2026-03', '2026-04']);
  assert.equal(monthsBetween('2025-11-01', '2026-10-31').length, 12);
});

test('a month inside a range is cut to the range at either end', () => {
  // Year to date on 21 October: October runs only to the 21st.
  assert.deepEqual(monthWithin('2026-10', '2026-01-01', '2026-10-21'), { from: '2026-10-01', to: '2026-10-21' });
  // A range starting mid-month.
  assert.deepEqual(monthWithin('2026-03', '2026-03-15', '2026-06-30'), { from: '2026-03-15', to: '2026-03-31' });
  // A whole month in the middle is untouched.
  assert.deepEqual(monthWithin('2026-02', '2026-01-01', '2026-10-21'), { from: '2026-02-01', to: '2026-02-28' });
});
