// Rebuilds the SAMPLE database from scratch with made-up accounts and
// transactions, so there is
// always known, fake data to develop and try things against.
//
// Run with: npm run seed   (stop the server first; restart it afterwards)
//
// It deletes and recreates sample-data/sample.db. It can only ever touch that
// one file: the path comes from config.js, and the script refuses to run if
// config ever points at anything other than sample data.

import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { dbPath, isSampleData } from '../src/config.js';
import * as db from '../src/db.js';

if (!isSampleData || path.basename(dbPath) !== 'sample.db') {
  console.error(`Refusing to seed: ${dbPath} is not the sample database.`);
  process.exit(1);
}

// Start from an empty file so running this twice gives the same result.
rmSync(dbPath, { force: true });
mkdirSync(path.dirname(dbPath), { recursive: true });
db.openDb(dbPath);

// Credit card balances are negative when money is owed (see schema.sql).
const sampleAccounts = [
  { name: 'Everyday Checking', type: 'checking', openingBalanceCents: 245000, openingDate: '2026-01-01' },
  { name: 'Rainy Day Savings', type: 'savings', openingBalanceCents: 1000000, openingDate: '2026-01-01' },
  { name: 'Sample Visa', type: 'credit_card', openingBalanceCents: -31245, openingDate: '2026-01-01' },
];

const [checking, savings, visa] = sampleAccounts.map((account) => db.createAccount(account));

// Made-up transactions with made-up payees (each payee is created the first
// time it's used). Amounts are signed cents: negative = money out.
// A few share a date to show same-day ordering.
const sampleTransactions = [
  // Everyday Checking
  { accountId: checking, date: '2026-01-02', amountCents: 215000, payeeName: 'Acme Corp Payroll', status: 'reconciled' },
  { accountId: checking, date: '2026-01-03', amountCents: -140000, payeeName: 'Oak Street Apartments', memo: 'January rent', checkNumber: '1001', status: 'reconciled' },
  { accountId: checking, date: '2026-01-05', amountCents: -8642, payeeName: 'Corner Market', status: 'reconciled' },
  { accountId: checking, date: '2026-01-05', amountCents: -4110, payeeName: 'Quick Fuel', status: 'reconciled' },
  { accountId: checking, date: '2026-01-10', amountCents: -11237, payeeName: 'City Electric', status: 'cleared' },
  { accountId: checking, date: '2026-01-16', amountCents: 215000, payeeName: 'Acme Corp Payroll', status: 'cleared' },
  { accountId: checking, date: '2026-01-20', amountCents: -4890, payeeName: 'City Water', status: 'cleared' },
  { accountId: checking, date: '2026-01-22', amountCents: -13215, payeeName: 'Corner Market' },
  { accountId: checking, date: '2026-01-28', amountCents: -6000, payeeName: 'Sam the Sitter', checkNumber: '1002' },
  { accountId: checking, date: '2026-02-01', amountCents: -140000, payeeName: 'Oak Street Apartments', memo: 'February rent', checkNumber: '1003' },

  // Rainy Day Savings
  { accountId: savings, date: '2026-01-31', amountCents: 412, payeeName: 'Interest', status: 'cleared' },
  { accountId: savings, date: '2026-02-28', amountCents: 415, payeeName: 'Interest' },

  // Sample Visa: charges are negative, payments and refunds positive.
  { accountId: visa, date: '2026-01-04', amountCents: -6480, payeeName: 'Luigi’s Trattoria', status: 'cleared' },
  { accountId: visa, date: '2026-01-09', amountCents: -12999, payeeName: 'Online Megastore', status: 'cleared' },
  { accountId: visa, date: '2026-01-12', amountCents: 2500, payeeName: 'Online Megastore', memo: 'Refund', status: 'cleared' },
  { accountId: visa, date: '2026-01-20', amountCents: 31245, payeeName: 'Payment - thank you', status: 'cleared' },
  { accountId: visa, date: '2026-02-03', amountCents: -575, payeeName: 'Bean There Coffee' },
  { accountId: visa, date: '2026-02-03', amountCents: -4720, payeeName: 'Hometown Hardware' },
];

for (const transaction of sampleTransactions) {
  db.createTransaction(transaction);
}

console.log(
  `Sample database rebuilt at ${dbPath} with ${sampleAccounts.length} accounts ` +
    `and ${sampleTransactions.length} transactions.`
);
