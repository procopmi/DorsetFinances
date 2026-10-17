// Tests for importing bank rows: matching rows you entered by hand, linking
// transfer halves, and remembering payee rules. Run with: npm test
//
// The money promise: an import that matches a hand-entered row must not add
// that money a second time. Each test uses a throwaway in-memory database.

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
  checking = account('Checking', 'checking', 100000);
  card = account('Card', 'credit_card', 0);
});

function balanceOf(accountId) {
  const opening = db.getAccount(accountId).opening_balance_cents;
  const amounts = db.getRegister(accountId).map((r) => r.amount_cents);
  return runningBalances(opening, amounts).at(-1) ?? opening;
}

// One import row, as the server builds it from a parsed bank file.
const bankRow = (date, amountCents, description, extra = {}) => ({
  date,
  amountCents,
  payeeName: description,
  categoryId: null,
  memo: null,
  checkNumber: null,
  bankDescription: description,
  fingerprint: `test|${date}|${description}|${amountCents}`,
  ...extra,
});

test('a hand-entered check is matched, not added twice', () => {
  const myCheck = db.createTransaction({
    accountId: checking, date: '2026-02-01', amountCents: -6000, payeeName: 'Sam the Sitter', checkNumber: '1004',
  });

  const matches = db.findHandEnteredMatches({ accountId: checking, amountCents: -6000, date: '2026-02-04', checkNumber: '1004' });
  assert.deepEqual(matches.map((m) => m.id), [myCheck]);

  const counts = db.importTransactions(checking, [
    bankRow('2026-02-04', -6000, 'CHECK 1004', { checkNumber: '1004', handEnteredId: myCheck }),
  ]);
  assert.deepEqual(counts, { added: 0, matched: 1, linked: 0, rules: 0 });

  const rows = db.getRegister(checking);
  assert.equal(rows.length, 1);              // still one row
  assert.equal(rows[0].payee, 'Sam the Sitter'); // your payee kept
  assert.equal(rows[0].status, 'cleared');   // now cleared by the bank
  assert.equal(balanceOf(checking), 94000);  // 60.00 taken off once, not twice
  assert.equal(clearedBalance(100000, rows), 94000);
});

test('hand-entered matches need the same amount, uncleared, not imported, within 5 days', () => {
  db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -6001 });                      // wrong amount
  db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -6000, status: 'cleared' });   // already cleared
  db.createTransaction({ accountId: checking, date: '2026-01-20', amountCents: -6000 });                      // too long ago
  db.createTransaction({ accountId: card, date: '2026-02-01', amountCents: -6000 });                          // other account
  db.importTransactions(checking, [bankRow('2026-02-02', -6000, 'Earlier import')]);                          // itself imported
  assert.deepEqual(db.findHandEnteredMatches({ accountId: checking, amountCents: -6000, date: '2026-02-03' }), []);
});

test('a matching check number is the best hand-entered match', () => {
  const near = db.createTransaction({ accountId: checking, date: '2026-02-03', amountCents: -6000 });
  const sameCheck = db.createTransaction({ accountId: checking, date: '2026-02-01', amountCents: -6000, checkNumber: '1004' });
  const found = db.findHandEnteredMatches({ accountId: checking, amountCents: -6000, date: '2026-02-03', checkNumber: '1004' });
  assert.deepEqual(found.map((m) => m.id), [sameCheck, near]);
});

test('importing the other half of a transfer links the two', () => {
  // Checking's download was imported first: the card payment going out.
  db.importTransactions(checking, [bankRow('2026-09-03', -50000, 'Payment to card')]);
  const checkingSide = db.getRegister(checking)[0];

  // Now the card's download: the same payment arriving.
  const [candidate] = db.findTransferCandidatesFor({ accountId: card, amountCents: 50000, date: '2026-09-04' });
  assert.equal(candidate.id, checkingSide.id);

  const counts = db.importTransactions(card, [
    bankRow('2026-09-04', 50000, 'Payment Thank You', { linkToId: checkingSide.id, categoryId: null }),
  ]);
  assert.equal(counts.linked, 1);

  const cardSide = db.getRegister(card)[0];
  assert.equal(cardSide.transfer_id, checkingSide.id);
  assert.equal(db.getTransaction(checkingSide.id).transfer_id, cardSide.id);
  // The money is counted once on each side, and the total across both is unchanged.
  assert.equal(balanceOf(checking) + balanceOf(card), 100000);
});

test('a remembered rule is saved once and re-pointed rather than duplicated', () => {
  db.importTransactions(checking, [
    bankRow('2026-02-01', -5421, 'WEGMANS #93 MANALAPAN NJ', { payeeName: 'Wegmans', rule: { pattern: 'WEGMANS' } }),
  ]);
  db.importTransactions(checking, [
    bankRow('2026-02-08', -1200, 'WEGMANS #12 HOLMDEL NJ', { payeeName: 'Wegmans Market', rule: { pattern: 'wegmans' } }),
  ]);

  const rules = db.listPayeeRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].match_type, 'contains');
  assert.equal(rules[0].payee_name, 'Wegmans Market');
});

test('imported rows are cleared and keep the bank text', () => {
  db.importTransactions(checking, [bankRow('2026-02-01', -5421, 'WEGMANS #93', { payeeName: 'Wegmans' })]);
  const [row] = db.getRegister(checking);
  assert.equal(row.status, 'cleared');
  assert.equal(row.payee, 'Wegmans');
  assert.equal(db.importedFingerprints(checking).has('test|2026-02-01|WEGMANS #93|-5421'), true);
});
