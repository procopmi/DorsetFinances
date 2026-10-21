// Tests for the Budget screen's money math. Run with: npm test
//
// What "actual" means for a month: every categorized transaction dated in
// that month, from every account, with transfers left out. Spending shows as
// a positive amount and refunds lower it.
// What "planned" means: the month's one-off amount if set, otherwise the
// standing amount that started most recently. Each test uses a throwaway
// in-memory database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { buildBudget, plannedFor } from '../src/budget.js';

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

const budgetFor = (month) =>
  buildBudget(db.listCategories(), db.monthActuals(month), {
    month,
    plans: db.listBudgetPlans(),
    overrides: db.listBudgetOverrides(month),
  });

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
  assert.equal(budget.income.actualCents, 300000);
  assert.equal(budget.expenses.actualCents, 16550);
  assert.equal(budget.actualNetCents, 300000 - 16550);
});

test('a refund lowers its category, and can take it below zero', () => {
  add(card, '2026-03-05', -12000, groceries);
  add(card, '2026-03-20', 2000, groceries); // 20.00 refund
  add(card, '2026-03-21', 1500, dining);    // a refund with no spending this month

  const budget = budgetFor('2026-03');
  assert.equal(subLine(budget.expenses, groceries).actualCents, 10000);
  assert.equal(subLine(budget.expenses, dining).actualCents, -1500);
  assert.equal(budget.expenses.actualCents, 8500);
});

test('only transactions dated in the month count', () => {
  add(checking, '2026-02-28', -100, groceries);
  add(checking, '2026-03-01', -200, groceries);
  add(checking, '2026-03-31', -400, groceries);
  add(checking, '2026-04-01', -800, groceries);

  assert.equal(budgetFor('2026-03').expenses.actualCents, 600);
});

test('transfers are not income or spending', () => {
  db.createTransaction({
    accountId: checking, date: '2026-03-10', amountCents: -50000, payeeName: 'Card payment', transferAccountId: card,
  });

  const budget = budgetFor('2026-03');
  assert.equal(budget.income.actualCents, 0);
  assert.equal(budget.expenses.actualCents, 0);
  assert.equal(budget.income.uncategorized.count, 0);
  assert.equal(budget.expenses.uncategorized.count, 0);
});

test('closed accounts still count (their history is real)', () => {
  add(card, '2026-03-05', -12000, groceries);
  db.setAccountClosed(card, true);

  assert.equal(budgetFor('2026-03').expenses.actualCents, 12000);
});

test('uncategorized money is split into came in and went out, and counted in the totals', () => {
  add(checking, '2026-03-02', 5000);
  add(checking, '2026-03-03', -700);
  add(checking, '2026-03-04', -300);

  const budget = budgetFor('2026-03');
  assert.deepEqual(budget.income.uncategorized, { cents: 5000, count: 1, differenceCents: 5000 });
  assert.deepEqual(budget.expenses.uncategorized, { cents: 1000, count: 2, differenceCents: -1000 });
  assert.equal(budget.actualNetCents, 4000);
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
  assert.equal(budgetFor('2026-03').actualNetCents, registerNet);
});

test('buildBudget refuses amounts that are not whole cents', () => {
  const rows = [{ category_id: groceries, money_in: 0, total_cents: -10.5, count: 1 }];
  assert.throws(() => buildBudget(db.listCategories(), rows, { month: '2026-03', plans: [], overrides: [] }));
});

// --- Planned amounts ---

const plan = (categoryId, fromMonth, amountCents) => db.setStandingPlan({ categoryId, fromMonth, amountCents });
const plannedIn = (categoryId, month) =>
  plannedFor(categoryId, month, db.listBudgetPlans(), db.listBudgetOverrides(month));

test('nothing planned is 0', () => {
  assert.deepEqual(plannedIn(groceries, '2026-03'), { cents: 0, isOverride: false });
});

test('a standing amount applies from its start month on, not before', () => {
  plan(groceries, '2026-03', 50000);
  assert.equal(plannedIn(groceries, '2026-02').cents, 0);
  assert.equal(plannedIn(groceries, '2026-03').cents, 50000);
  assert.equal(plannedIn(groceries, '2027-01').cents, 50000); // across a year end
});

test('changing the standing amount later leaves earlier months as they were', () => {
  plan(groceries, '2026-01', 50000);
  plan(groceries, '2026-06', 60000);
  assert.equal(plannedIn(groceries, '2026-05').cents, 50000);
  assert.equal(plannedIn(groceries, '2026-06').cents, 60000);
  assert.equal(plannedIn(groceries, '2026-12').cents, 60000);
});

test('"this month and later" replaces later standing amounts, but keeps later one-offs', () => {
  plan(groceries, '2026-01', 50000);
  plan(groceries, '2026-06', 60000);
  db.setMonthOverride({ categoryId: groceries, month: '2026-12', amountCents: 90000 });

  plan(groceries, '2026-03', 55000);
  assert.equal(plannedIn(groceries, '2026-02').cents, 50000);
  assert.equal(plannedIn(groceries, '2026-03').cents, 55000);
  assert.equal(plannedIn(groceries, '2026-07').cents, 55000); // the June change is gone
  assert.equal(plannedIn(groceries, '2026-12').cents, 90000); // the December one-off stays
});

test('a one-month amount beats the standing amount for that month only, and clearing it restores it', () => {
  plan(dining, '2026-01', 10000);
  db.setMonthOverride({ categoryId: dining, month: '2026-12', amountCents: 30000 });
  assert.deepEqual(plannedIn(dining, '2026-12'), { cents: 30000, isOverride: true });
  assert.equal(plannedIn(dining, '2026-11').cents, 10000);
  assert.equal(plannedIn(dining, '2027-01').cents, 10000);

  db.clearMonthOverride(dining, '2026-12');
  assert.deepEqual(plannedIn(dining, '2026-12'), { cents: 10000, isOverride: false });
});

test('setting the usual amount in a month with a one-off replaces the one-off', () => {
  db.setMonthOverride({ categoryId: dining, month: '2026-03', amountCents: 30000 });
  plan(dining, '2026-03', 12000);
  assert.deepEqual(plannedIn(dining, '2026-03'), { cents: 12000, isOverride: false });
});

test('a one-off of 0 means "nothing this month", not "use the usual amount"', () => {
  plan(dining, '2026-01', 10000);
  db.setMonthOverride({ categoryId: dining, month: '2026-03', amountCents: 0 });
  assert.deepEqual(plannedIn(dining, '2026-03'), { cents: 0, isOverride: true });
});

test('differences: positive is good for both expenses and income', () => {
  plan(pay, '2026-01', 400000);
  plan(groceries, '2026-01', 50000);
  plan(dining, '2026-01', 10000);
  add(checking, '2026-03-01', 430000, pay);     // 300.00 more income than planned
  add(card, '2026-03-05', -45000, groceries);   // 50.00 under plan
  add(card, '2026-03-06', -12500, dining);      // 25.00 over plan
  add(checking, '2026-03-07', -1000);           // 10.00 unplanned, uncategorized

  const budget = budgetFor('2026-03');
  assert.equal(subLine(budget.income, pay).differenceCents, 30000);
  assert.equal(subLine(budget.expenses, groceries).differenceCents, 5000);
  assert.equal(subLine(budget.expenses, dining).differenceCents, -2500);

  const food = budget.expenses.groups[0];
  assert.deepEqual([food.plannedCents, food.actualCents, food.differenceCents], [60000, 57500, 2500]);

  // The uncategorized 10.00 counts in full against what's left.
  assert.deepEqual(
    [budget.expenses.plannedCents, budget.expenses.actualCents, budget.expenses.differenceCents],
    [60000, 58500, 1500]
  );
  assert.equal(budget.plannedNetCents, 400000 - 60000);
  assert.equal(budget.actualNetCents, 430000 - 58500);
});

test('a hidden category with a plan still shows, so the planned total adds up', () => {
  plan(retired, '2026-01', 2500);
  const line = subLine(budgetFor('2026-03').expenses, retired);
  assert.equal(line.plannedCents, 2500);
  assert.equal(budgetFor('2026-03').expenses.plannedCents, 2500);
});

test('the database refuses negative or fractional planned amounts', () => {
  assert.throws(() => plan(groceries, '2026-03', -100));
  assert.throws(() => plan(groceries, '2026-03', 10.5));
  assert.throws(() => db.setMonthOverride({ categoryId: groceries, month: '2026-03', amountCents: -1 }));
});

// --- Data safety ---

test('deleting a category removes its budget amounts in the same step', () => {
  const spare = db.createCategory({ name: 'Spare', kind: 'expense', parentId: db.getCategory(groceries).parent_id });
  plan(spare, '2026-01', 1000);
  db.setMonthOverride({ categoryId: spare, month: '2026-03', amountCents: 2000 });

  db.deleteCategory(spare);
  assert.equal(db.getCategory(spare), undefined);
  assert.equal(db.listBudgetPlans().length, 0);
  assert.equal(db.listBudgetOverrides('2026-03').length, 0);
});

test('a refused category delete keeps its budget amounts', () => {
  plan(groceries, '2026-01', 50000);
  db.setMonthOverride({ categoryId: groceries, month: '2026-03', amountCents: 60000 });
  add(checking, '2026-03-05', -100, groceries); // in use, so the database refuses the delete

  assert.throws(() => db.deleteCategory(groceries));
  assert.ok(db.getCategory(groceries));
  assert.equal(db.listBudgetPlans().length, 1);
  assert.equal(db.listBudgetOverrides('2026-03').length, 1);
});
