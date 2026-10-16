// Tests for money conversion. Run with: npm test
// node:test and node:assert are built into Node, so no test library is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDollarsToCents, formatCents } from '../src/money.js';

test('parses ordinary amounts into whole cents', () => {
  assert.equal(parseDollarsToCents('12'), 1200);
  assert.equal(parseDollarsToCents('12.34'), 1234);
  assert.equal(parseDollarsToCents('0.05'), 5);
  assert.equal(parseDollarsToCents('.50'), 50);
});

test('a single digit after the point means tens of cents', () => {
  assert.equal(parseDollarsToCents('12.3'), 1230);
  assert.equal(parseDollarsToCents('1,234.5'), 123450);
});

test('accepts commas, a dollar sign, a minus sign and stray spaces', () => {
  assert.equal(parseDollarsToCents('1,234,567.89'), 123456789);
  assert.equal(parseDollarsToCents('$1,234.56'), 123456);
  assert.equal(parseDollarsToCents('-12.34'), -1234);
  assert.equal(parseDollarsToCents('-$5'), -500);
  assert.equal(parseDollarsToCents('  7.00 '), 700);
});

test('avoids the classic floating-point error', () => {
  // As decimals, 0.1 + 0.2 is 0.30000000000000004. In cents it's exact.
  assert.equal(parseDollarsToCents('0.10') + parseDollarsToCents('0.20'), 30);
});

test('negative zero is stored as plain zero', () => {
  assert.ok(Object.is(parseDollarsToCents('-0.00'), 0));
});

test('rejects text that is not a valid amount', () => {
  for (const bad of ['', ' ', 'abc', '12.345', '1.2.3', '1,23.00', '12,34', '$', '-', '.', '5-', '$-5']) {
    assert.throws(() => parseDollarsToCents(bad), /not a valid amount/, `should reject "${bad}"`);
  }
});

test('rejects amounts too large to count exactly', () => {
  assert.throws(() => parseDollarsToCents('99999999999999999999'), /too large/);
});

test('formats cents for display', () => {
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(1230), '12.30');
  assert.equal(formatCents(123456789), '1,234,567.89');
  assert.equal(formatCents(-123450), '-1,234.50');
});

test('formatting refuses anything that is not whole cents', () => {
  assert.throws(() => formatCents(12.5));
  assert.throws(() => formatCents('100'));
});

test('parsing and formatting round-trip', () => {
  for (const cents of [0, 1, 99, 100, 123456, -987654321]) {
    assert.equal(parseDollarsToCents(formatCents(cents)), cents);
  }
});
