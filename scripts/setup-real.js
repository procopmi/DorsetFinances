// One-time setup: creates your REAL database, with the approved categories
// and no accounts. You then add your accounts in the app.
//
// Run with: npm run setup
// The path comes from FINANCE_DB in .env (see .env.example). If a file is
// already there, this refuses and changes nothing, so it can never overwrite
// your data.

import { existsSync } from 'node:fs';

import { dbPath, isSampleData } from '../src/config.js';
import * as db from '../src/db.js';
import { addDefaultCategories, defaultCategories } from '../src/default-categories.js';

if (isSampleData) {
  console.error('Setup is only for the real database. The sample one is built by: npm run seed');
  process.exit(1);
}
if (existsSync(dbPath)) {
  console.error(`Refusing to set up: ${dbPath} already exists. Nothing was changed.`);
  process.exit(1);
}

db.openDb(dbPath); // creates the file and its tables (schema.sql)
const subCount = addDefaultCategories().size;
console.log(
  `Created ${dbPath} with ${defaultCategories.length} category groups and ${subCount} sub-categories. ` +
    'Start the app with: npm start'
);
