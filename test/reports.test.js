// Tests for the Reports screen's money math. Run with: npm test
//
// The reports count money the same way the Budget screen does (every
// account, transfers left out, spending positive, refunds lower their
// category), and their totals must match the registers. Each test uses a
// throwaway in-memory database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { spendingByCategory } from '../src/reports.js';

let checking;
let card;
let groceries;
let dining;
let electric;
let pay;

beforeEach(() => {
  db.openDb(':memory:');
  const account = (name, type) => db.createAccount({ name, type, openingBalanceCents: 0, openingDate: '2026-01-01' });
  checking = account('Checking', 'checking');
  card = account('Card', 'credit_card');

  const food = db.createCategory({ name: 'Food', kind: 'expense' });
  groceries = db.createCategory({ name: 'Groceries', kind: 'expense', parentId: food });
  dining = db.createCategory({ name: 'Dining Out', kind: 'expense', parentId: food });
  const utilities = db.createCategory({ name: 'Utilities', kind: 'expense' });
  electric = db.createCategory({ name: 'Electric', kind: 'expense', parentId: utilities });
  db.createCategory({ name: 'Water', kind: 'expense', parentId: utilities }); // never used
  const income = db.createCategory({ name: 'Michael Income', kind: 'income' });
  pay = db.createCategory({ name: 'Pay', kind: 'income', parentId: income });
});

function add(accountId, date, amountCents, categoryId = null) {
  return db.createTransaction({ accountId, date, amountCents, categoryId, payeeName: 'Someone' });
}

const spending = (from, to) => spendingByCategory(db.listCategories(), db.actualsBetween(from, to));

test('spending is positive, groups are largest first, and empty categories are left out', () => {
  add(card, '2026-03-05', -12000, groceries);
  add(card, '2026-03-06', -3000, dining);
  add(checking, '2026-03-10', -20000, electric);
  add(checking, '2026-03-01', 300000, pay); // income: not spending

  const report = spending('2026-03-01', '2026-03-31');
  assert.deepEqual(report.groups.map((g) => [g.name, g.cents]), [['Utilities', 20000], ['Food', 15000]]);
  assert.deepEqual(report.groups[1].subs.map((s) => [s.name, s.cents]), [['Groceries', 12000], ['Dining Out', 3000]]);
  assert.equal(report.groups[0].subs.length, 1); // Water had nothing
  assert.equal(report.totalCents, 35000);
});

test('a range includes both of its end days, and nothing outside them', () => {
  add(card, '2026-02-28', -1, groceries);
  add(card, '2026-03-01', -10, groceries);
  add(card, '2026-04-30', -100, groceries);
  add(card, '2026-05-01', -1000, groceries);

  assert.equal(spending('2026-03-01', '2026-04-30').totalCents, 110);
  assert.equal(spending('2026-03-01', '2026-03-01').totalCents, 10);
});

test('refunds lower their category; transfers are not spending', () => {
  add(card, '2026-03-05', -12000, groceries);
  add(card, '2026-03-20', 2000, groceries);
  db.createTransaction({ accountId: checking, date: '2026-03-10', amountCents: -50000, payeeName: 'Pay card', transferAccountId: card });

  const report = spending('2026-03-01', '2026-03-31');
  assert.equal(report.totalCents, 10000);
  assert.equal(report.uncategorized.count, 0);
});

test('uncategorized money out is its own line and counts in the total', () => {
  add(card, '2026-03-05', -7500, groceries);
  add(checking, '2026-03-07', -2500);
  add(checking, '2026-03-08', 9999); // uncategorized money in: not spending

  const report = spending('2026-03-01', '2026-03-31');
  assert.deepEqual(report.uncategorized, { cents: 2500, count: 1, sharePercent: 25 });
  assert.equal(report.totalCents, 10000);
  assert.equal(report.groups[0].sharePercent, 75);
});

test('the spending total matches the money out of the registers (minus transfers and income)', () => {
  add(card, '2026-03-05', -12345, groceries);
  add(card, '2026-03-06', 1000, groceries);
  add(checking, '2026-03-10', -6789, electric);
  add(checking, '2026-03-11', -111);

  // Every non-transfer row in an expense category or uncategorized money out.
  const expenseIds = new Set([groceries, dining, electric]);
  const registerSpending = [checking, card]
    .flatMap((id) => db.getRegister(id))
    .filter((t) => t.transfer_id === null && (expenseIds.has(t.category_id) || (t.category_id === null && t.amount_cents < 0)))
    .reduce((sum, t) => sum - t.amount_cents, 0);
  assert.equal(spending('2026-03-01', '2026-03-31').totalCents, registerSpending);
});

test('a period with no spending has an empty report and 0 shares', () => {
  const report = spending('2026-03-01', '2026-03-31');
  assert.deepEqual(report.groups, []);
  assert.equal(report.totalCents, 0);
  assert.equal(report.uncategorized.sharePercent, 0);
});

// --- Drill-down: the transactions behind an amount ---

const listed = (what) => db.transactionsFor({ from: '2026-03-01', to: '2026-03-31', ...what });
// Spending is the register amounts flipped (money out is negative there).
const spent = (rows) => -rows.reduce((sum, t) => sum + t.amount_cents, 0);

// A month with a bit of everything: refunds, other months, a transfer,
// income, uncategorized money both ways.
function busyMonth() {
  add(card, '2026-02-28', -999, groceries);      // last month
  add(card, '2026-03-01', -12000, groceries);
  add(card, '2026-03-20', 2000, groceries);      // refund
  add(card, '2026-03-31', -3000, dining);
  add(checking, '2026-04-01', -999, dining);     // next month
  add(checking, '2026-03-10', -20000, electric);
  add(checking, '2026-03-01', 300000, pay);
  add(checking, '2026-03-07', -2500);            // uncategorized out
  add(checking, '2026-03-08', 4000);             // uncategorized in
  db.createTransaction({ accountId: checking, date: '2026-03-15', amountCents: -50000, payeeName: 'Pay card', transferAccountId: card });
}

test('a sub-category lists exactly the rows behind its amount', () => {
  busyMonth();
  const report = spending('2026-03-01', '2026-03-31');
  const food = report.groups.find((g) => g.name === 'Food');
  const groceriesLine = food.subs.find((s) => s.id === groceries);

  const rows = listed({ categoryIds: [groceries] });
  assert.equal(rows.length, 2); // the charge and the refund, not February's
  assert.equal(spent(rows), groceriesLine.cents);
});

test('a group lists all of its subs, adding up to the group amount', () => {
  busyMonth();
  const food = spending('2026-03-01', '2026-03-31').groups.find((g) => g.name === 'Food');
  const rows = listed({ categoryIds: [groceries, dining] });
  assert.equal(rows.length, 3); // includes 31 March, not 1 April
  assert.equal(spent(rows), food.cents);
});

test('uncategorized in and out list only their own direction', () => {
  busyMonth();
  const out = listed({ uncategorized: 'out' });
  const into = listed({ uncategorized: 'in' });
  assert.equal(spent(out), spending('2026-03-01', '2026-03-31').uncategorized.cents);
  assert.deepEqual(into.map((t) => t.amount_cents), [4000]);
});

test('transfers are never listed, even though they have no category', () => {
  busyMonth();
  const all = [...listed({ uncategorized: 'out' }), ...listed({ uncategorized: 'in' })];
  assert.ok(all.every((t) => t.payee !== 'Pay card'));
});

test('listed rows carry what the list shows: date, account, payee, category, memo', () => {
  add(card, '2026-03-05', -1234, groceries);
  const [row] = listed({ categoryIds: [groceries] });
  assert.equal(row.date, '2026-03-05');
  assert.equal(row.account, 'Card');
  assert.equal(row.payee, 'Someone');
  assert.equal(row.category, 'Food: Groceries');
  assert.equal(row.amount_cents, -1234);
});
