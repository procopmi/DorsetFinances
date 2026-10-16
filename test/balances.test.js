// Tests for running balances. Run with: npm test
//
// Two parts: the arithmetic itself (runningBalances), and the order the database
// returns transactions in. The balance is only right if the order is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningBalances } from '../src/money.js';
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
