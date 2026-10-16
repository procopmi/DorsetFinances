// Tests for transfers between accounts. Run with: npm test
//
// The core promise of a transfer: money leaves one account and arrives in the
// other, so the two registers change by opposite amounts and the total across
// both accounts stays the same. Each test uses a throwaway in-memory database.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runningBalances, clearedBalance } from '../src/money.js';
import * as db from '../src/db.js';

let checking;
let card;

beforeEach(() => {
  db.openDb(':memory:');
  const account = (name, type, openingBalanceCents) =>
    db.createAccount({ name, type, openingBalanceCents, openingDate: '2026-01-01' });
  checking = account('Checking', 'checking', 100000); // has 1,000.00
  card = account('Card', 'credit_card', -50000);      // owes 500.00
});

// The account's balance after all its transactions.
function balanceOf(accountId) {
  const opening = db.getAccount(accountId).opening_balance_cents;
  const amounts = db.getRegister(accountId).map((r) => r.amount_cents);
  return runningBalances(opening, amounts).at(-1) ?? opening;
}

// Pay the card 300.00 from checking, entered on the checking side.
function payCard(amountCents = -30000) {
  return db.createTransaction({
    accountId: checking,
    date: '2026-01-15',
    amountCents,
    payeeName: 'Card payment',
    transferAccountId: card,
  });
}

test('a transfer moves money between accounts without changing the total', () => {
  const totalBefore = balanceOf(checking) + balanceOf(card);
  payCard();

  assert.equal(balanceOf(checking), 70000); // 1,000.00 - 300.00
  assert.equal(balanceOf(card), -20000);    // owed 500.00, now owes 200.00
  assert.equal(balanceOf(checking) + balanceOf(card), totalBefore);
});

test('both halves point at each other and carry no category', () => {
  const id = payCard();
  const [here] = db.getRegister(checking);
  const [there] = db.getRegister(card);

  assert.equal(here.id, id);
  assert.equal(here.transfer_id, there.id);
  assert.equal(there.transfer_id, here.id);
  assert.equal(here.transfer_account, 'Card');
  assert.equal(there.transfer_account, 'Checking');
  assert.equal(here.category_id, null);
  assert.equal(there.category_id, null);
  // The other side is new to that bank, so it starts uncleared.
  assert.equal(there.status, 'uncleared');
});

test('editing the amount keeps the other half mirrored', () => {
  const id = payCard();
  const fields = { date: '2026-01-15', payeeName: 'Card payment', transferAccountId: card };
  db.updateTransaction(id, { ...fields, amountCents: -45000 });

  assert.equal(balanceOf(checking), 55000);
  assert.equal(balanceOf(card), -5000);
});

test('the date follows only when both halves had the same date', () => {
  const id = payCard();
  const base = { amountCents: -30000, payeeName: 'Card payment', transferAccountId: card };

  db.updateTransaction(id, { ...base, date: '2026-01-16' });
  assert.equal(db.getRegister(card)[0].date, '2026-01-16'); // dates matched, so it followed

  // Two imported rows linked as a transfer keep the dates each bank gave them.
  const out = db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -7500 });
  const back = db.createTransaction({ accountId: card, date: '2026-02-03', amountCents: 7500 });
  db.linkTransfer(out, back);
  db.updateTransaction(out, { amountCents: -7500, date: '2026-02-02', transferAccountId: card });
  assert.equal(db.getTransaction(back).date, '2026-02-03');
});

test('deleting one half deletes both', () => {
  const id = payCard();
  db.deleteTransaction(id);
  assert.equal(db.getRegister(checking).length, 0);
  assert.equal(db.getRegister(card).length, 0);
  assert.equal(balanceOf(checking) + balanceOf(card), 50000);
});

test('linking two imported rows makes a transfer and clears their categories', () => {
  const groceries = db.createCategory({ name: 'Groceries', kind: 'expense' });
  // Imagine both arrived by CSV import, a day apart, one wrongly categorized.
  const out = db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -12345, categoryId: groceries });
  const back = db.createTransaction({ accountId: card, date: '2026-02-02', amountCents: 12345 });

  const candidates = db.findTransferCandidates(out);
  assert.deepEqual(candidates.map((c) => c.id), [back]);

  db.linkTransfer(out, back);
  assert.equal(db.getTransaction(out).transfer_id, back);
  assert.equal(db.getTransaction(back).transfer_id, out);
  assert.equal(db.getRegister(checking)[0].category_id, null);
});

test('transfer candidates need the opposite amount, another account and a near date', () => {
  const out = db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -10000 });
  db.createTransaction({ accountId: card, date: '2026-02-01', amountCents: 9999 });     // wrong amount
  db.createTransaction({ accountId: card, date: '2026-02-20', amountCents: 10000 });    // too far away
  db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: 10000 }); // same account
  assert.deepEqual(db.findTransferCandidates(out), []);
});

test('unlinking keeps both rows and their money', () => {
  const id = payCard();
  db.unlinkTransfer(id);
  assert.equal(db.getTransaction(id).transfer_id, null);
  assert.equal(db.getRegister(card)[0].transfer_id, null);
  assert.equal(balanceOf(checking), 70000);
  assert.equal(balanceOf(card), -20000);
});

test('each half is cleared on its own', () => {
  payCard();
  const [here] = db.getRegister(checking);
  db.setTransactionStatus(here.id, 'cleared');
  // Checking's bank has it; the card company may not yet.
  assert.equal(clearedBalance(100000, db.getRegister(checking)), 70000);
  assert.equal(clearedBalance(-50000, db.getRegister(card)), -50000);
});
