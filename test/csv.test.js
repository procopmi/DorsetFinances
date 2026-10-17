// Tests for CSV writing and the register export. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvField, safeText, buildCsv, exportRegisterCsv } from '../src/csv.js';
import { centsToPlainText } from '../src/money.js';

// --- Plain amounts ---

test('cents become plain numbers with no commas or rounding', () => {
  assert.equal(centsToPlainText(0), '0.00');
  assert.equal(centsToPlainText(5), '0.05');
  assert.equal(centsToPlainText(-5), '-0.05');
  assert.equal(centsToPlainText(123456), '1234.56');
  assert.equal(centsToPlainText(-123456789), '-1234567.89');
  // 0.1 + 0.2 as decimals is 0.30000000000000004; in cents it's exactly 30.
  assert.equal(centsToPlainText(10 + 20), '0.30');
  assert.throws(() => centsToPlainText(12.5));
});

// --- Quoting ---

test('plain values are written as they are', () => {
  assert.equal(csvField('Corner Market'), 'Corner Market');
  assert.equal(csvField('-1234.56'), '-1234.56');
  assert.equal(csvField(null), '');
});

test('values with commas, quotes or line breaks are quoted', () => {
  assert.equal(csvField('Smith, Jones & Co'), '"Smith, Jones & Co"');
  assert.equal(csvField('The "good" bakery'), '"The ""good"" bakery"');
  assert.equal(csvField('line one\nline two'), '"line one\nline two"');
});

test('text that a spreadsheet would treat as a formula is made plain text', () => {
  assert.equal(safeText('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(safeText('+1 Mobile'), "'+1 Mobile");
  assert.equal(safeText('@home'), "'@home");
  assert.equal(safeText('Corner Market'), 'Corner Market');
});

test('a CSV file has a header marker, comma-joined fields and \\r\\n line ends', () => {
  const text = buildCsv([['a', 'b,c'], ['1', '2']]);
  assert.equal(text, '﻿a,"b,c"\r\n1,2\r\n');
});

// --- Register export ---

// A small fake register, shaped like db.getRegister rows.
const row = (date, amount_cents, extra = {}) => ({
  date,
  amount_cents,
  status: 'uncleared',
  check_number: null,
  payee: null,
  memo: null,
  category_group: null,
  category_name: null,
  transfer_id: null,
  transfer_account: null,
  ...extra,
});

const checking = {
  name: 'Everyday Checking',
  opening_balance_cents: 100000,
  rows: [
    row('2026-01-05', -2500, { payee: 'Corner Market', category_group: 'Food', category_name: 'Groceries', status: 'cleared' }),
    row('2026-02-10', -50000, { payee: 'Move to savings', transfer_id: 9, transfer_account: 'Rainy Day Savings' }),
    row('2026-03-01', 215000, { payee: 'Acme, Inc.', category_group: 'Michael Income', category_name: 'Pay', check_number: '1001' }),
  ],
};

// The exported lines, without the leading marker, split back into lines.
const linesOf = (csv) => csv.replace('﻿', '').trimEnd().split('\r\n');

test('the export has the header and one line per transaction', () => {
  const lines = linesOf(exportRegisterCsv([checking]));
  assert.equal(lines[0], 'Date,Account,Num,Payee,Category Group,Category,Memo,Amount,Status,Balance');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '2026-01-05,Everyday Checking,,Corner Market,Food,Groceries,,-25.00,cleared,975.00');
});

test('transfers show "Transfer" and the other account instead of a category', () => {
  const lines = linesOf(exportRegisterCsv([checking]));
  assert.equal(lines[2], '2026-02-10,Everyday Checking,,Move to savings,Transfer,Rainy Day Savings,,-500.00,uncleared,475.00');
});

test('a date range leaves out rows outside it', () => {
  const lines = linesOf(exportRegisterCsv([checking], { from: '2026-02-01', to: '2026-02-28' }));
  assert.equal(lines.length, 2); // header + the February row
  assert.match(lines[1], /^2026-02-10,/);
});

test('balances in a date-limited export still count earlier transactions', () => {
  // Starting in March, the balance must include January and February.
  const lines = linesOf(exportRegisterCsv([checking], { from: '2026-03-01' }));
  assert.equal(lines[1], '2026-03-01,Everyday Checking,1001,"Acme, Inc.",Michael Income,Pay,,2150.00,uncleared,2625.00');
});

test('all-accounts export keeps each account\'s own running balance', () => {
  const savings = {
    name: 'Rainy Day Savings',
    opening_balance_cents: 0,
    rows: [row('2026-02-10', 50000, { transfer_id: 2, transfer_account: 'Everyday Checking' })],
  };
  const lines = linesOf(exportRegisterCsv([checking, savings]));
  assert.equal(lines.length, 5);
  assert.equal(lines[4], '2026-02-10,Rainy Day Savings,,,Transfer,Everyday Checking,,500.00,uncleared,500.00');
});
