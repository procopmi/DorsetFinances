// The starting category list, approved 2026-10-16 (adapted from the old
// household spreadsheet). It's plain data so it's easy to read and edit here.
//
// Used to fill a brand-new database: the sample one now (npm run seed), and the
// real one when it's first set up. After that, categories are managed in the
// app, so editing this file does not change an existing database.
//
// Plain hyphens ("Car Loan - Michael") rather than dashes, so names are easy
// to type.

import * as db from './db.js';

export const defaultCategories = [
  // --- Income ---
  { group: 'Cindy Income', kind: 'income', subs: ['Pay', 'Bonus', 'Expense Reimbursement'] },
  { group: 'Michael Income', kind: 'income', subs: ['Pay', 'Bonus', 'Expense Reimbursement', 'WFH Stipend'] },
  { group: 'Tax Refunds', kind: 'income', subs: ['Federal', 'New Jersey', 'New York'] },
  // Repayments: money paid back to you, e.g. a Zelle for a dinner you covered.
  { group: 'Other Income', kind: 'income', subs: ['Unemployment', 'Interest', 'Repayments', 'Other'] },

  // --- Expenses ---
  // Mortgage includes escrowed property tax and homeowners insurance.
  { group: 'Housing', kind: 'expense', subs: ['Mortgage', 'HELOC', 'Repairs & Maintenance'] },
  // Gas = natural gas for the house (car fuel is Auto: Fuel).
  { group: 'Utilities', kind: 'expense', subs: ['Electric', 'Gas', 'Water', 'Sewer', 'TV/Internet', 'Cell Phones'] },
  {
    group: 'Home Services',
    kind: 'expense',
    subs: ['Cleaning', 'Landscaping', 'Sprinkler Service', 'Pest Control Plan', 'HVAC Service Plan', 'Generator Service Plan'],
  },
  { group: 'Pool', kind: 'expense', subs: ['Pool Service', 'Water Testing', 'Chemicals & Supplies'] },
  {
    group: 'Auto',
    kind: 'expense',
    subs: ['Car Loan - Michael', 'Car Insurance', 'Fuel', 'Maintenance & Repairs', 'Tolls & Parking'],
  },
  { group: 'Insurance', kind: 'expense', subs: ['Umbrella Policy', 'Long-Term Care', 'Life - Cindy', 'Life - Michael'] },
  {
    group: 'Pets',
    kind: 'expense',
    subs: ['Veterinarian', 'Food & Supplies', 'Grooming', 'Pet Sitting', 'HomeAgain Membership'],
  },
  {
    group: 'Health & Fitness',
    kind: 'expense',
    subs: ['Peloton', 'Club Pilates - Cindy', 'Club Pilates - Michael', 'Medical & Dental', 'Pharmacy'],
  },
  // The payee says which service (AppleOne, SiriusXM, Prime, ChatGPT, Claude...).
  { group: 'Subscriptions', kind: 'expense', subs: ['Streaming & Media', 'Software & AI'] },
  { group: 'Food', kind: 'expense', subs: ['Groceries', 'Dining Out'] },
  { group: 'Banking & Fees', kind: 'expense', subs: ['Credit Card Annual Fees', 'Other Fees'] },
  // Tax you pay; the counterpart to Tax Refunds.
  { group: 'Taxes', kind: 'expense', subs: ['Federal', 'New Jersey', 'New York'] },
  { group: 'Other', kind: 'expense', subs: ['Gifts', 'Charity', 'Clothing', 'Household Supplies', 'Miscellaneous'] },
];

// Adds the list above to an open, empty database. sort_order follows the list
// so groups and subs appear in the order written here.
// Returns a lookup from "Group: Sub" to the new category id, which the sample
// seed script uses to assign categories to its transactions.
export function addDefaultCategories() {
  const idsByLabel = new Map();
  defaultCategories.forEach(({ group, kind, subs }, groupIndex) => {
    const groupId = db.createCategory({ name: group, kind, parentId: null, sortOrder: groupIndex });
    subs.forEach((sub, subIndex) => {
      const subId = db.createCategory({ name: sub, kind, parentId: groupId, sortOrder: subIndex });
      idsByLabel.set(`${group}: ${sub}`, subId);
    });
  });
  return idsByLabel;
}
