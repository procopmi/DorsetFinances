// Rebuilds the SAMPLE database from scratch with made-up accounts, so there is
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

for (const account of sampleAccounts) {
  db.createAccount(account);
}

console.log(`Sample database rebuilt at ${dbPath} with ${sampleAccounts.length} accounts.`);
