// Tests for the Budget screen's money math. Run with: npm test
//
// What "actual" means for a month: every categorized transaction dated in
// that month, from every account, with transfers left out. Spending shows as
// a positive amount and refunds lower it. Each test uses a throwaway
// in-memory database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { buildBudget } from '../src/budget.js';

let checking;
let card;
let groceries;
let dining;
let pay;
let retired; // a hidden expense sub

beforeEach(() => {
  db.openDb(':memory:');
  const account = (name, type) => db.createAccount({ name, type, openingBalanceCents: 0, openingDate: '2026-01-01' });
  checking = account('Checking', 'checking');
  card = account('Card', 'credit_card');

  const food = db.createCategory({ name: 'Food', kind: 'expense' });
  groceries = db.createCategory({ name: 'Groceries', kind: 'expense', parentId: food });
  dining = db.createCategory({ name: 'Dining Out', kind: 'expense', parentId: food });
  retired = db.createCategory({ name: 'Old Stuff', kind: 'expense', parentId: food });
  db.setCategoryHidden(retired, true);
  const income = db.createCategory({ name: 'Michael Income', kind: 'income' });
  pay = db.createCategory({ name: 'Pay', kind: 'income', parentId: income });
});

function add(accountId, date, amountCents, categoryId = null) {
  return db.createTransaction({ accountId, date, amountCents, categoryId, payeeName: 'Someone' });
}

const budgetFor = (month) => buildBudget(db.listCategories(), db.monthActuals(month));

// Find a sub's line in a section, by category id.
function subLine(section, id) {
  return section.groups.flatMap((g) => g.subs).find((s) => s.id === id);
}

test('spending shows as positive, income as positive, net is the difference', () => {
  add(checking, '2026-03-01', 300000, pay);      // paid 3,000.00
  add(card, '2026-03-05', -12000, groceries);    // spent 120.00
  add(checking, '2026-03-09', -4550, dining);    // spent 45.50

  const budget = budgetFor('2026-03');
  assert.equal(subLine(budget.income, pay).actualCents, 300000);
  assert.equal(subLine(budget.expenses, groceries).actualCents, 12000);
  assert.equal(budget.expenses.groups[0].actualCents, 16550); // Food = groceries + dining
  assert.equal(budget.income.totalCents, 300000);
  assert.equal(budget.expenses.totalCents, 16550);
  assert.equal(budget.netCents, 300000 - 16550);
});

test('a refund lowers its category, and can take it below zero', () => {
  add(card, '2026-03-05', -12000, groceries);
  add(card, '2026-03-20', 2000, groceries); // 20.00 refund
  add(card, '2026-03-21', 1500, dining);    // a refund with no spending this month

  const budget = budgetFor('2026-03');
  assert.equal(subLine(budget.expenses, groceries).actualCents, 10000);
  assert.equal(subLine(budget.expenses, dining).actualCents, -1500);
  assert.equal(budget.expenses.totalCents, 8500);
});

test('only transactions dated in the month count', () => {
  add(checking, '2026-02-28', -100, groceries);
  add(checking, '2026-03-01', -200, groceries);
  add(checking, '2026-03-31', -400, groceries);
  add(checking, '2026-04-01', -800, groceries);

  assert.equal(budgetFor('2026-03').expenses.totalCents, 600);
});

test('transfers are not income or spending', () => {
  db.createTransaction({
    accountId: checking, date: '2026-03-10', amountCents: -50000, payeeName: 'Card payment', transferAccountId: card,
  });

  const budget = budgetFor('2026-03');
  assert.equal(budget.income.totalCents, 0);
  assert.equal(budget.expenses.totalCents, 0);
  assert.equal(budget.income.uncategorized.count, 0);
  assert.equal(budget.expenses.uncategorized.count, 0);
});

test('closed accounts still count (their history is real)', () => {
  add(card, '2026-03-05', -12000, groceries);
  db.setAccountClosed(card, true);

  assert.equal(budgetFor('2026-03').expenses.totalCents, 12000);
});

test('uncategorized money is split into came in and went out, and counted in the totals', () => {
  add(checking, '2026-03-02', 5000);
  add(checking, '2026-03-03', -700);
  add(checking, '2026-03-04', -300);

  const budget = budgetFor('2026-03');
  assert.deepEqual(budget.income.uncategorized, { cents: 5000, count: 1 });
  assert.deepEqual(budget.expenses.uncategorized, { cents: 1000, count: 2 });
  assert.equal(budget.netCents, 4000);
});

test('a hidden category shows only when it has money that month', () => {
  assert.equal(subLine(budgetFor('2026-03').expenses, retired), undefined);

  add(checking, '2026-03-02', -999, retired);
  const line = subLine(budgetFor('2026-03').expenses, retired);
  assert.equal(line.actualCents, 999);
  assert.equal(line.isHidden, true);
});

test('the budget totals match the registers (all money in and out, minus transfers)', () => {
  add(checking, '2026-03-01', 300000, pay);
  add(checking, '2026-03-02', -4550, dining);
  add(card, '2026-03-05', -12000, groceries);
  add(card, '2026-03-06', 2000, groceries);
  add(checking, '2026-03-07', -1234);
  db.createTransaction({
    accountId: checking, date: '2026-03-10', amountCents: -10000, payeeName: 'Card payment', transferAccountId: card,
  });

  // Net change across both registers this month, ignoring the transfer
  // (which cancels out across the two accounts anyway).
  const registerNet = [checking, card]
    .flatMap((id) => db.getRegister(id))
    .filter((t) => t.date.startsWith('2026-03') && t.transfer_id === null)
    .reduce((sum, t) => sum + t.amount_cents, 0);
  assert.equal(budgetFor('2026-03').netCents, registerNet);
});

test('buildBudget refuses amounts that are not whole cents', () => {
  const rows = [{ category_id: groceries, money_in: 0, total_cents: -10.5, count: 1 }];
  assert.throws(() => buildBudget(db.listCategories(), rows));
});
