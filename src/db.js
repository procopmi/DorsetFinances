// The ONLY file in the app that talks to SQLite.
//
// Everything else calls the plain functions exported here (listAccounts, and
// more as milestones add them) and never writes SQL itself. Think of it like a
// ServiceNow Script Include that wraps every GlideRecord call: if we ever change
// how data is stored, this is the only file that has to change.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// One open connection shared by the whole app. SQLite is a single file on disk
// and this app has one user, so a single connection is all we need.
let db;

// Opens (or creates) the database file and makes sure all tables exist.
// Pass ':memory:' to get a throwaway in-memory database, which is what tests use.
export function openDb(filePath) {
  db = new DatabaseSync(filePath);

  // SQLite ignores REFERENCES rules unless this is switched on per connection.
  // With it on, the database refuses e.g. a transaction for an account that
  // doesn't exist.
  db.exec('PRAGMA foreign_keys = ON;');

  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
}

// --- Accounts ---
//
// The "?" placeholders below are filled in by SQLite from the values passed to
// run()/get(). Never build SQL by gluing strings together: placeholders keep a
// value like "Bob's Checking" (note the quote) from breaking the query.

// All accounts, open ones first, in the order they should appear in the sidebar.
// Closed accounts are included so the sidebar can offer to reopen them.
export function listAccounts() {
  return db
    .prepare(
      `SELECT id, name, type, opening_balance_cents, opening_date, is_closed, sort_order
         FROM accounts
        ORDER BY is_closed, sort_order, name`
    )
    .all();
}

// One account, or undefined if there's no account with that id.
export function getAccount(id) {
  return db
    .prepare(
      `SELECT id, name, type, opening_balance_cents, opening_date, is_closed, sort_order
         FROM accounts
        WHERE id = ?`
    )
    .get(id);
}

// Adds an account and returns its new id.
export function createAccount({ name, type, openingBalanceCents, openingDate }) {
  const result = db
    .prepare(
      `INSERT INTO accounts (name, type, opening_balance_cents, opening_date)
       VALUES (?, ?, ?, ?)`
    )
    .run(name, type, openingBalanceCents, openingDate);
  return Number(result.lastInsertRowid);
}

// The functions below return true if an account with that id existed, so the
// caller can tell "done" apart from "no such account".

export function renameAccount(id, name) {
  return db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

// Closing hides an account from the main list but keeps all its history.
export function setAccountClosed(id, isClosed) {
  return (
    db.prepare('UPDATE accounts SET is_closed = ? WHERE id = ?').run(isClosed ? 1 : 0, id).changes > 0
  );
}

export function countTransactions(accountId) {
  return db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE account_id = ?').get(accountId)
    .count;
}

// Permanently removes an account. The database itself also refuses this if the
// account still has transactions (the foreign key rule), so history can never
// be orphaned even if a caller forgets to check countTransactions first.
export function deleteAccount(id) {
  return db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
}

// --- Helpers ---

// Runs several database writes as one all-or-nothing unit. (SQLite calls this
// a "transaction", which is unrelated to a register transaction.) If anything
// inside fails, ROLLBACK undoes the earlier writes too, so we never end up with,
// say, a new payee saved but the register line that needed it missing.
function allOrNothing(work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- Categories ---

// Every category, groups and subs together, in display order. A row with
// parent_id null is a group; the others are subs that belong to a group.
// Hidden ones are included so existing transactions can still show their
// names; the page leaves them out of the suggestions.
export function listCategories() {
  return db
    .prepare(
      `SELECT id, name, parent_id, kind, is_hidden, sort_order
         FROM categories
        ORDER BY sort_order, id`
    )
    .all();
}

export function getCategory(id) {
  return db.prepare('SELECT id, name, parent_id, kind, is_hidden FROM categories WHERE id = ?').get(id);
}

// Adds a group (parentId null) or a sub (parentId = its group) and returns the new id.
export function createCategory({ name, kind, parentId = null, sortOrder = 0 }) {
  const result = db
    .prepare('INSERT INTO categories (name, kind, parent_id, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, kind, parentId, sortOrder);
  return Number(result.lastInsertRowid);
}

// --- Payees ---

// Payees for autocomplete, alphabetically, with the category to fill in
// automatically when one is chosen.
export function listPayees() {
  return db
    .prepare('SELECT id, name, default_category_id FROM payees WHERE is_hidden = 0 ORDER BY name')
    .all();
}

// Remembers the category most recently used with a payee, so picking that
// payee next time fills it in. Called whenever a transaction is saved.
function rememberPayeeCategory(payeeId, categoryId) {
  if (payeeId && categoryId) {
    db.prepare('UPDATE payees SET default_category_id = ? WHERE id = ?').run(categoryId, payeeId);
  }
}

// Returns the id of the payee with this name, creating it if it's new. The
// name column ignores capitalization (COLLATE NOCASE in schema.sql), so
// "pg&e" finds an existing "PG&E" instead of making a near-duplicate.
function findOrCreatePayee(name) {
  const existing = db.prepare('SELECT id FROM payees WHERE name = ?').get(name);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO payees (name) VALUES (?)').run(name).lastInsertRowid);
}

// --- Transactions ---

// Adds a transaction and returns its new id. amountCents is signed:
// positive = money in, negative = money out. payeeName is plain text; the
// matching payee is looked up or created here. categoryId may be null
// (uncategorized).
export function createTransaction({
  accountId,
  date,
  amountCents,
  payeeName = null,
  categoryId = null,
  memo = null,
  checkNumber = null,
  status = 'uncleared',
}) {
  return allOrNothing(() => {
    const payeeId = payeeName ? findOrCreatePayee(payeeName) : null;
    const result = db
      .prepare(
        `INSERT INTO transactions
           (account_id, date, amount_cents, payee_id, category_id, memo, check_number, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(accountId, date, amountCents, payeeId, categoryId, memo, checkNumber, status);
    rememberPayeeCategory(payeeId, categoryId);
    return Number(result.lastInsertRowid);
  });
}

// Changes the fields you can edit in the register. Status is left as it is
// (it has its own controls). Returns false if there's no transaction with that id.
export function updateTransaction(
  id,
  { date, amountCents, payeeName = null, categoryId = null, memo = null, checkNumber = null }
) {
  return allOrNothing(() => {
    // Check first, so a missing transaction doesn't leave a new payee behind.
    if (!db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id)) return false;

    const payeeId = payeeName ? findOrCreatePayee(payeeName) : null;
    db.prepare(
      `UPDATE transactions
          SET date = ?, amount_cents = ?, payee_id = ?, category_id = ?, memo = ?, check_number = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(date, amountCents, payeeId, categoryId, memo, checkNumber, id);
    rememberPayeeCategory(payeeId, categoryId);
    return true;
  });
}

export function deleteTransaction(id) {
  return db.prepare('DELETE FROM transactions WHERE id = ?').run(id).changes > 0;
}

// One account's transactions in register order: by date, and within the same
// date by id (the order they were entered). That ordering is what makes the
// running balance come out the same every time.
//
// Payee and category names are looked up by joining their tables. LEFT JOIN
// keeps a transaction even when it has no payee or category yet (name = null).
// The category is shown as "Group: Sub", so the categories table is joined a
// second time (as "g") to get the sub's group name.
export function getRegister(accountId) {
  return db
    .prepare(
      `SELECT t.id, t.date, t.check_number, t.memo, t.amount_cents, t.status,
              p.name AS payee, t.category_id, g.name || ': ' || c.name AS category
         FROM transactions t
         LEFT JOIN payees p ON p.id = t.payee_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories g ON g.id = c.parent_id
        WHERE t.account_id = ?
        ORDER BY t.date, t.id`
    )
    .all(accountId);
}
