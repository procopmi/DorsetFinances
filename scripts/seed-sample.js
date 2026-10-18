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
import { addDefaultCategories } from '../src/default-categories.js';

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
  // Cash balance only: transfers in and out, plus dividends.
  { name: 'Sample Fidelity Money Market', type: 'investment', openingBalanceCents: 2000000, openingDate: '2026-01-01' },
];

const [checking, savings, visa, fidelity] = sampleAccounts.map((account) => db.createAccount(account));

// The approved category list (src/default-categories.js).
const categoryIds = addDefaultCategories();

// Made-up transactions with made-up payees (each payee is created the first
// time it's used). Amounts are signed cents: negative = money out.
// `category` is a "Group: Sub" label from the default list; leaving it out
// means uncategorized. A few share a date to show same-day ordering.
const sampleTransactions = [
  // Everyday Checking
  { accountId: checking, date: '2026-01-02', amountCents: 215000, payeeName: 'Acme Corp Payroll', category: 'Michael Income: Pay', status: 'reconciled' },
  { accountId: checking, date: '2026-01-03', amountCents: -140000, payeeName: 'Sample Mortgage Co', category: 'Housing: Mortgage', memo: 'January payment', checkNumber: '1001', status: 'reconciled' },
  { accountId: checking, date: '2026-01-05', amountCents: -8642, payeeName: 'Corner Market', category: 'Food: Groceries', status: 'reconciled' },
  { accountId: checking, date: '2026-01-05', amountCents: -4110, payeeName: 'Quick Fuel', category: 'Auto: Fuel', status: 'reconciled' },
  { accountId: checking, date: '2026-01-10', amountCents: -11237, payeeName: 'City Electric', category: 'Utilities: Electric', status: 'cleared' },
  { accountId: checking, date: '2026-01-16', amountCents: 215000, payeeName: 'Acme Corp Payroll', category: 'Michael Income: Pay', status: 'cleared' },
  // A transfer entered by hand: creates the matching +500.00 row in savings.
  { accountId: checking, date: '2026-01-17', amountCents: -50000, payeeName: 'Move to savings', transferAccountId: savings, status: 'cleared' },
  // The checking side of the Visa payment, as checking's bank download would show it
  // (linked to the Visa's own row below, as if both were imported).
  { accountId: checking, date: '2026-01-19', amountCents: -31245, payeeName: 'Sample Visa', memo: 'Card payment', status: 'cleared' },
  { accountId: checking, date: '2026-01-20', amountCents: -4890, payeeName: 'City Water', category: 'Utilities: Water', status: 'cleared' },
  { accountId: checking, date: '2026-01-22', amountCents: -13215, payeeName: 'Corner Market', category: 'Food: Groceries' },
  { accountId: checking, date: '2026-01-25', amountCents: 5000, payeeName: 'Friend via Zelle', category: 'Other Income: Repayments', memo: 'Their half of dinner' },
  { accountId: checking, date: '2026-01-28', amountCents: -6000, payeeName: 'Paws Pet Sitting', category: 'Pets: Pet Sitting', checkNumber: '1002' },
  { accountId: checking, date: '2026-02-01', amountCents: -140000, payeeName: 'Sample Mortgage Co', category: 'Housing: Mortgage', memo: 'February payment', checkNumber: '1003' },

  { accountId: checking, date: '2026-01-14', amountCents: -10000, payeeName: 'Transfer to Fidelity', transferAccountId: fidelity, status: 'cleared' },
  { accountId: checking, date: '2026-01-29', amountCents: -10000, payeeName: 'ATM', category: 'Other: Cash', status: 'cleared' },
  // One insurer billing two life policies with the same bank text: the
  // amount rule below tells them apart (try importing more of these).
  { accountId: checking, date: '2026-01-15', amountCents: -8000, payeeName: 'Sample Life Co', category: 'Insurance: Life - Cindy', status: 'cleared' },
  { accountId: checking, date: '2026-01-15', amountCents: -14000, payeeName: 'Sample Life Co', category: 'Insurance: Life - Michael', status: 'cleared' },

  // Sample Fidelity Money Market: a dividend, reinvested in the fund, so this
  // deposit is the only entry needed.
  { accountId: fidelity, date: '2026-01-31', amountCents: 6712, payeeName: 'Fidelity dividend', category: 'Other Income: Dividends' },

  // Rainy Day Savings
  { accountId: savings, date: '2026-01-31', amountCents: 412, payeeName: 'Interest', category: 'Other Income: Interest', status: 'cleared' },
  { accountId: savings, date: '2026-02-28', amountCents: 415, payeeName: 'Interest', category: 'Other Income: Interest' },

  // Sample Visa: charges are negative, payments and refunds positive.
  // A refund goes back to the original purchase's category.
  { accountId: visa, date: '2026-01-04', amountCents: -6480, payeeName: 'Luigi’s Trattoria', category: 'Food: Dining Out', status: 'cleared' },
  { accountId: visa, date: '2026-01-09', amountCents: -12999, payeeName: 'Online Megastore', category: 'Other: Household Supplies', status: 'cleared' },
  { accountId: visa, date: '2026-01-12', amountCents: 2500, payeeName: 'Online Megastore', category: 'Other: Household Supplies', memo: 'Refund', status: 'cleared' },
  // The card side of the payment, a day later than checking's: linked below.
  { accountId: visa, date: '2026-01-20', amountCents: 31245, payeeName: 'Payment - thank you', status: 'cleared' },
  { accountId: visa, date: '2026-02-03', amountCents: -1499, payeeName: 'AppleOne', category: 'Subscriptions: Streaming & Media' },
  { accountId: visa, date: '2026-02-03', amountCents: -4720, payeeName: 'Hometown Hardware', category: 'Housing: Repairs & Maintenance' },
];

for (const { category, ...transaction } of sampleTransactions) {
  // Turn the label into an id; a typo in a label above stops the seed loudly
  // instead of silently leaving the transaction uncategorized.
  const categoryId = category ? categoryIds.get(category) : null;
  if (categoryId === undefined) throw new Error(`Unknown category label in seed data: "${category}"`);
  db.createTransaction({ ...transaction, categoryId });
}

// Link the two halves of the Visa payment, as "Link as transfer" would.
const checkingSide = db.getRegister(checking).find((t) => t.payee === 'Sample Visa');
const visaSide = db.getRegister(visa).find((t) => t.payee === 'Payment - thank you');
db.linkTransfer(checkingSide.id, visaSide.id);

// Sample Life Co: under $100.00 is Cindy's policy, otherwise Michael's.
db.setAmountRule({
  payeeId: db.findPayeeByName('Sample Life Co').id,
  thresholdCents: 10000,
  belowCategoryId: categoryIds.get('Insurance: Life - Cindy'),
  otherwiseCategoryId: categoryIds.get('Insurance: Life - Michael'),
});

console.log(
  `Sample database rebuilt at ${dbPath} with ${sampleAccounts.length} accounts, ` +
    `${categoryIds.size} categories and ${sampleTransactions.length} transactions.`
);
