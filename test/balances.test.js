// Tests for running balances. Run with: npm test
//
// Two parts: the arithmetic itself (runningBalances), and the order the database
// returns transactions in. The balance is only right if the order is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningBalances, clearedBalance, registerView } from '../src/money.js';
import * as db from '../src/db.js';

test('an account with no transactions has no balance rows', () => {
  assert.deepEqual(runningBalances(245000, []), []);
});

test('each balance is the previous balance plus the amount', () => {
  // Opening 100.00, deposit 50.00, payment 30.25, payment 0.75
  assert.deepEqual(runningBalances(10000, [5000, -3025, -75]), [15000, 11975, 11900]);
});

test('a checking account can go below zero (overdraft)', () => {
  assert.deepEqual(runningBalances(2000, [-5000, 10000]), [-3000, 7000]);
});

test('credit card: charges make the balance more negative, payments bring it back', () => {
  // Owes 312.45 to start; charges 50.00; pays the 312.45; still owes 50.00.
  assert.deepEqual(runningBalances(-31245, [-5000, 31245]), [-36245, -5000]);
});

test('balances refuse anything that is not whole cents', () => {
  assert.throws(() => runningBalances(10.5, [100]));
  assert.throws(() => runningBalances(0, [100, 0.1]));
});

// --- Cleared balance (what the bank should show) ---

// Shorthand for a transaction as the register returns it.
const t = (amount_cents, status) => ({ amount_cents, status });

test('cleared balance with nothing cleared is the opening balance', () => {
  assert.equal(clearedBalance(245000, []), 245000);
  assert.equal(clearedBalance(245000, [t(-5000, 'uncleared'), t(10000, 'uncleared')]), 245000);
});

test('cleared balance counts cleared and reconciled items, not uncleared ones', () => {
  // 100.00 opening; -25.00 cleared; +50.00 reconciled; -10.00 not yet at the bank.
  assert.equal(
    clearedBalance(10000, [t(-2500, 'cleared'), t(5000, 'reconciled'), t(-1000, 'uncleared')]),
    12500
  );
});

test('cleared balance on a credit card: charges owed, payment not yet posted', () => {
  // Owes 312.45; a 50.00 charge has posted; a 312.45 payment hasn't yet.
  assert.equal(clearedBalance(-31245, [t(-5000, 'cleared'), t(31245, 'uncleared')]), -36245);
});

test('cleared balance refuses anything that is not whole cents', () => {
  assert.throws(() => clearedBalance(10.5, []));
  assert.throws(() => clearedBalance(0, [t(0.1, 'cleared')]));
});

test('register order: by date, then by entry order within the same day', () => {
  // A throwaway in-memory database, so no file is ever touched.
  db.openDb(':memory:');
  const accountId = db.createAccount({
    name: 'Test Checking',
    type: 'checking',
    openingBalanceCents: 10000,
    openingDate: '2026-01-01',
  });

  // Entered out of date order on purpose.
  db.createTransaction({ accountId, date: '2026-01-05', amountCents: -2000, memo: 'second day, first entered' });
  db.createTransaction({ accountId, date: '2026-01-02', amountCents: 5000, memo: 'first day' });
  db.createTransaction({ accountId, date: '2026-01-05', amountCents: -500, memo: 'second day, second entered' });

  const rows = db.getRegister(accountId);
  assert.deepEqual(
    rows.map((r) => r.memo),
    ['first day', 'second day, first entered', 'second day, second entered']
  );
  assert.deepEqual(
    runningBalances(10000, rows.map((r) => r.amount_cents)),
    [15000, 13000, 12500]
  );
});

test('the register only includes the requested account', () => {
  db.openDb(':memory:');
  const make = (name) =>
    db.createAccount({ name, type: 'checking', openingBalanceCents: 0, openingDate: '2026-01-01' });
  const first = make('First');
  const second = make('Second');

  db.createTransaction({ accountId: first, date: '2026-01-02', amountCents: 100 });
  db.createTransaction({ accountId: second, date: '2026-01-02', amountCents: 999 });

  assert.deepEqual(db.getRegister(first).map((r) => r.amount_cents), [100]);
});

// --- Date filter (registerView) ---

// A small register: opening 1,000.00, then four rows with their running balances.
const reg = [
  { id: 1, date: '2025-11-20', balance_cents: 90000 },
  { id: 2, date: '2025-12-31', balance_cents: 85000 },
  { id: 3, date: '2026-01-01', balance_cents: 95000 },
  { id: 4, date: '2026-02-10', balance_cents: 80000 },
];
const ids = (view) => view.rows.map((r) => r.id);

test('no dates: every row, and the real opening balance', () => {
  const view = registerView(reg, 100000, { from: '', to: '' });
  assert.deepEqual(ids(view), [1, 2, 3, 4]);
  assert.equal(view.hasEarlier, false);
  assert.equal(view.forwardCents, 100000);
});

test('a range in the middle: balance forward is the last hidden row\'s balance', () => {
  const view = registerView(reg, 100000, { from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(ids(view), [3]);
  assert.equal(view.hasEarlier, true);
  assert.equal(view.forwardCents, 85000);
  // The rows keep their whole-history balances.
  assert.equal(view.rows[0].balance_cents, 95000);
});

test('rows on the From and To dates are included', () => {
  assert.deepEqual(ids(registerView(reg, 100000, { from: '2025-12-31', to: '2026-01-01' })), [2, 3]);
});

test('a range before the first transaction starts from the opening balance', () => {
  const view = registerView(reg, 100000, { from: '2025-01-01', to: '2025-06-30' });
  assert.deepEqual(ids(view), []);
  assert.equal(view.hasEarlier, false);
  assert.equal(view.forwardCents, 100000);
});

test('an empty range after some rows still knows the balance forward', () => {
  const view = registerView(reg, 100000, { from: '2026-01-02', to: '2026-01-31' });
  assert.deepEqual(ids(view), []);
  assert.equal(view.forwardCents, 95000);
});

test('open-ended ranges: only From, or only To', () => {
  assert.deepEqual(ids(registerView(reg, 100000, { from: '2026-01-01', to: '' })), [3, 4]);
  const view = registerView(reg, 100000, { from: '', to: '2025-12-31' });
  assert.deepEqual(ids(view), [1, 2]);
  assert.equal(view.forwardCents, 100000);
});
