// Tests for re-applying payee rules to rows already imported (milestone 13):
// rows imported before the rules were set up get the payee and category the
// rules would give them today. Run with: npm test
//
// The data promise: only uncategorized, imported, non-transfer rows in open
// accounts are ever changed, so a category you chose yourself is never
// overwritten. Each test uses a throwaway in-memory database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { proposeRuleResults } from '../src/rules.js';

let checking;
let card;
let groceries;
let lifeA;
let lifeB;

beforeEach(() => {
  db.openDb(':memory:');
  const account = (name, type) => db.createAccount({ name, type, openingBalanceCents: 0, openingDate: '2026-01-01' });
  checking = account('Checking', 'checking');
  card = account('Card', 'credit_card');
  const food = db.createCategory({ name: 'Food', kind: 'expense', parentId: null });
  groceries = db.createCategory({ name: 'Groceries', kind: 'expense', parentId: food });
  const insurance = db.createCategory({ name: 'Insurance', kind: 'expense', parentId: null });
  lifeA = db.createCategory({ name: 'Life A', kind: 'expense', parentId: insurance });
  lifeB = db.createCategory({ name: 'Life B', kind: 'expense', parentId: insurance });
});

// One imported row with no category: its payee is the raw bank text, as an
// import made before any rules existed would have left it.
function importRaw(accountId, date, amountCents, description) {
  db.importTransactions(accountId, [{
    date, amountCents, payeeName: description, categoryId: null, memo: null, checkNumber: null,
    bankDescription: description, fingerprint: `test|${date}|${description}|${amountCents}`,
  }]);
}

// A payee with a default category and a "contains" rule pointing at it.
function payeeWithRule(name, categoryId, pattern) {
  const id = db.createTransaction({ accountId: checking, date: '2026-01-01', amountCents: -1, payeeName: name, categoryId });
  db.deleteTransaction(id); // the payee stays, remembering the category
  const payeeId = db.findPayeeByName(name).id;
  db.addPayeeRule({ matchType: 'contains', pattern, payeeId });
  return payeeId;
}

const propose = () => proposeRuleResults(db.uncategorizedImportedRows(), db.listPayeeRules(), db.getAmountRule);

// Preview then commit, as the server does.
function applyAll() {
  const changes = propose().proposals.map((p) => ({ id: p.id, payeeId: p.newPayeeId, categoryId: p.newCategoryId }));
  return db.applyRuleResults(changes);
}

const rowsOf = (accountId) => db.getRegister(accountId);

test('an uncategorized imported row gets the rule\'s payee and category', () => {
  importRaw(card, '2026-02-01', -4512, 'WEGMANS #93 MANALAPAN NJ');
  payeeWithRule('Wegmans', groceries, 'WEGMANS');

  const { proposals, unchanged } = propose();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].payee, 'WEGMANS #93 MANALAPAN NJ');
  assert.equal(proposals[0].newPayee, 'Wegmans');
  assert.equal(unchanged, 0);

  assert.equal(applyAll(), 1);
  const [row] = rowsOf(card);
  assert.equal(row.payee, 'Wegmans');
  assert.equal(row.category_id, groceries);
  assert.equal(row.amount_cents, -4512); // money untouched
  assert.equal(row.status, 'cleared');   // status untouched
});

test('a row with no rule but a payee that has a default category gets that category', () => {
  importRaw(card, '2026-02-01', -4512, 'Wegmans');
  payeeWithRule('Wegmans', groceries, 'NOT IN THIS TEXT');
  assert.equal(applyAll(), 1);
  assert.equal(rowsOf(card)[0].category_id, groceries);
});

test('rows no rule or default helps are counted, not proposed', () => {
  importRaw(card, '2026-02-01', -999, 'MYSTERY SHOP');
  const { proposals, unchanged } = propose();
  assert.equal(proposals.length, 0);
  assert.equal(unchanged, 1);
});

test('an amount rule picks the category by size', () => {
  importRaw(checking, '2026-02-01', -5000, 'LIFECO PREMIUM 1');
  importRaw(checking, '2026-02-02', -20000, 'LIFECO PREMIUM 2');
  const payeeId = payeeWithRule('Life Co', groceries, 'LIFECO');
  db.setAmountRule({ payeeId, thresholdCents: 10000, belowCategoryId: lifeA, otherwiseCategoryId: lifeB });

  applyAll();
  assert.deepEqual(rowsOf(checking).map((r) => r.category_id), [lifeA, lifeB]);
});

test('categorized rows, hand-entered rows, transfers and closed accounts are left alone', () => {
  payeeWithRule('Wegmans', groceries, 'WEGMANS');
  // Imported, but you already chose a category.
  db.importTransactions(card, [{
    date: '2026-02-01', amountCents: -100, payeeName: 'WEGMANS A', categoryId: lifeA, memo: null, checkNumber: null,
    bankDescription: 'WEGMANS A', fingerprint: 'test|a',
  }]);
  // Entered by hand: no bank text to run rules on.
  db.createTransaction({ accountId: card, date: '2026-02-02', amountCents: -200, payeeName: 'WEGMANS B' });
  // An imported transfer half.
  importRaw(card, '2026-02-03', 300, 'WEGMANS C');
  const half = rowsOf(card).at(-1).id;
  const other = db.createTransaction({ accountId: checking, date: '2026-02-03', amountCents: -300 });
  db.linkTransfer(half, other);
  // An imported row in a closed account.
  const old = db.createAccount({ name: 'Old', type: 'checking', openingBalanceCents: 0, openingDate: '2026-01-01' });
  importRaw(old, '2026-02-04', -400, 'WEGMANS D');
  db.setAccountClosed(old, true);

  assert.deepEqual(propose().proposals, []);
  assert.equal(applyAll(), 0);
  assert.deepEqual(rowsOf(card).map((r) => r.category_id), [lifeA, null, null]);
  assert.equal(rowsOf(old)[0].payee, 'WEGMANS D');
});

test('a row categorized after the preview is not overwritten', () => {
  importRaw(card, '2026-02-01', -4512, 'WEGMANS #93');
  payeeWithRule('Wegmans', groceries, 'WEGMANS');
  const changes = propose().proposals.map((p) => ({ id: p.id, payeeId: p.newPayeeId, categoryId: p.newCategoryId }));

  // Meanwhile, you set a category by hand in the register.
  const id = rowsOf(card)[0].id;
  db.updateTransaction(id, { date: '2026-02-01', amountCents: -4512, payeeName: 'My Pick', categoryId: lifeA });

  assert.equal(db.applyRuleResults(changes), 0);
  const [row] = rowsOf(card);
  assert.equal(row.payee, 'My Pick');
  assert.equal(row.category_id, lifeA);
});

test('all or nothing: one bad change undoes the others', () => {
  importRaw(card, '2026-02-01', -100, 'WEGMANS 1');
  importRaw(card, '2026-02-02', -200, 'WEGMANS 2');
  const payeeId = payeeWithRule('Wegmans', groceries, 'WEGMANS');
  const [first, second] = rowsOf(card).map((r) => r.id);

  assert.throws(() =>
    db.applyRuleResults([
      { id: first, payeeId, categoryId: groceries },
      { id: second, payeeId, categoryId: 999999 }, // no such category
    ])
  );
  assert.deepEqual(rowsOf(card).map((r) => r.category_id), [null, null]);
  assert.deepEqual(rowsOf(card).map((r) => r.payee), ['WEGMANS 1', 'WEGMANS 2']);
});
