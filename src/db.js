// The ONLY file in the app that talks to SQLite.
//
// Everything else calls the plain functions exported here (listAccounts, and
// more as milestones add them) and never writes SQL itself. Think of it like a
// ServiceNow Script Include that wraps every GlideRecord call: if we ever change
// how data is stored, this is the only file that has to change.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { MIGRATIONS } from './migrations.js';

// One open connection shared by the whole app. SQLite is a single file on disk
// and this app has one user, so a single connection is all we need.
let db;

// The schema version this code expects: the last upgrade step's number.
export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

// Opens (or creates) the database file and brings its tables up to date.
// Pass ':memory:' to get a throwaway in-memory database, which is what tests use.
//
// beforeSchemaChange: called (to make a backup) just before an existing
// database is upgraded. Project rule: back up before a schema change.
// Returns { from, to } versions, which are equal if nothing was upgraded.
export function openDb(filePath, { beforeSchemaChange } = {}) {
  db = new DatabaseSync(filePath);

  // SQLite ignores REFERENCES rules unless this is switched on per connection.
  // With it on, the database refuses e.g. a transaction for an account that
  // doesn't exist.
  db.exec('PRAGMA foreign_keys = ON;');

  return prepareSchema(db, { beforeSchemaChange });
}

// Gets a database's tables to the current version (see migrations.js):
//   - newer than this code knows: refused, unchanged (old code mustn't
//     write to a database a newer version has changed);
//   - empty (just created): built from schema.sql and stamped as current;
//   - older: backed up (beforeSchemaChange), then each missing step is run
//     in order, each all-or-nothing together with its new version number,
//     so a failed step leaves the file at the version before it;
//   - current: left alone.
// Takes the connection and step list as arguments so tests can try it on
// their own in-memory databases with made-up steps.
export function prepareSchema(connection, { migrations = MIGRATIONS, beforeSchemaChange } = {}) {
  const latest = migrations.at(-1).version;
  const from = connection.prepare('PRAGMA user_version').get().user_version;

  if (from > latest) {
    throw new Error(
      `This database is at schema version ${from}, but this version of the app only knows up to ` +
        `${latest}. It was probably changed by a newer version of the app. Nothing was changed.`
    );
  }

  const isEmpty = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get() === undefined;
  if (isEmpty) {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    connection.exec('BEGIN');
    try {
      connection.exec(schema);
      connection.exec(`PRAGMA user_version = ${latest}`);
      connection.exec('COMMIT');
    } catch (err) {
      connection.exec('ROLLBACK');
      throw err;
    }
    return { from: latest, to: latest };
  }

  const steps = migrations.filter((m) => m.version > from);
  if (steps.length > 0) beforeSchemaChange?.();
  for (const step of steps) {
    connection.exec('BEGIN');
    try {
      step.up(connection);
      // user_version is part of the file, so it commits (or rolls back) with the step.
      connection.exec(`PRAGMA user_version = ${step.version}`);
      connection.exec('COMMIT');
    } catch (err) {
      connection.exec('ROLLBACK');
      throw new Error(`Upgrading the database to version ${step.version} (${step.about}) failed: ${err.message}`);
    }
  }
  return { from, to: latest };
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
      `SELECT id, name, parent_id, kind, is_hidden, sort_order, is_recurring
         FROM categories
        ORDER BY sort_order, id`
    )
    .all();
}

export function getCategory(id) {
  return db.prepare('SELECT id, name, parent_id, kind, is_hidden FROM categories WHERE id = ?').get(id);
}

// The sort_order that puts a new category last among its siblings (the other
// groups, or the other subs of the same group). "parent_id IS ?" rather than
// "= ?" so that it also works for groups, whose parent_id is null.
function nextSortOrder(parentId) {
  return db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM categories WHERE parent_id IS ?')
    .get(parentId).next;
}

// Adds a group (parentId null) or a sub (parentId = its group) and returns the
// new id. Without a sortOrder it goes at the end of its list.
export function createCategory({ name, kind, parentId = null, sortOrder = nextSortOrder(parentId) }) {
  const result = db
    .prepare('INSERT INTO categories (name, kind, parent_id, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, kind, parentId, sortOrder);
  return Number(result.lastInsertRowid);
}

// True if another category in the same place (same group, or among the
// groups) already has this name, ignoring capitalization. exceptId lets a
// rename to "the same name with different capitals" through.
export function categoryNameTaken(name, parentId, exceptId = 0) {
  return Boolean(
    db
      .prepare('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND parent_id IS ? AND id != ?')
      .get(name, parentId, exceptId)
  );
}

// The functions below return true if a category with that id existed.

export function renameCategory(id, name) {
  return db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export function setCategoryHidden(id, isHidden) {
  return (
    db.prepare('UPDATE categories SET is_hidden = ? WHERE id = ?').run(isHidden ? 1 : 0, id).changes > 0
  );
}

// Marks a sub as a recurring bill (or back to "other"), for the Budget
// screen's subtotals.
export function setCategoryRecurring(id, isRecurring) {
  return (
    db.prepare('UPDATE categories SET is_recurring = ? WHERE id = ?').run(isRecurring ? 1 : 0, id).changes > 0
  );
}

// Moves a sub to another group, placing it last there. It takes on the new
// group's kind, so a sub moved into an income group counts as income.
export function moveCategory(id, newParentId) {
  return (
    db
      .prepare(
        `UPDATE categories
            SET parent_id = ?, sort_order = ?,
                kind = (SELECT kind FROM categories WHERE id = ?)
          WHERE id = ?`
      )
      .run(newParentId, nextSortOrder(newParentId), newParentId, id).changes > 0
  );
}

export function countCategoryTransactions(id) {
  return db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE category_id = ?').get(id).count;
}

export function countSubcategories(id) {
  return db.prepare('SELECT COUNT(*) AS count FROM categories WHERE parent_id = ?').get(id).count;
}

// Permanently removes a category. The caller checks first that no transaction
// uses it; the database's foreign key rule would refuse anyway. Payees that
// used it as their default simply lose that default, and its budget amounts
// go with it (the page's confirm message says so).
export function deleteCategory(id) {
  return allOrNothing(() => {
    db.prepare('UPDATE payees SET default_category_id = NULL WHERE default_category_id = ?').run(id);
    db.prepare('DELETE FROM budget_plans WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM budget_overrides WHERE category_id = ?').run(id);
    return db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0;
  });
}

// --- Budget ---

// The money per category between two dates (both included, 'YYYY-MM-DD'),
// for the Budget screen (one month) and the reports (any range). Dates are
// stored as 'YYYY-MM-DD' text, which sorts in date order, so BETWEEN works.
// Every account counts (closed ones too: it's still history), and cleared
// status doesn't matter. Transfers are left out: they only move money
// between your own accounts, so they're neither income nor spending.
//
// Grouped by category AND by direction (money in or out), so uncategorized
// rows can be shown as "came in" and "went out" separately. For a real
// category the two are simply added back together (see budget.js), so a
// refund still lowers that category's spending.
// Returns rows of { category_id (null = uncategorized), money_in (1 or 0),
// total_cents, count }.
export function actualsBetween(from, to) {
  return db
    .prepare(
      `SELECT category_id, amount_cents > 0 AS money_in,
              SUM(amount_cents) AS total_cents, COUNT(*) AS count
         FROM transactions
        WHERE date BETWEEN ? AND ? AND transfer_id IS NULL
        GROUP BY category_id, money_in`
    )
    .all(from, to);
}

// Every standing planned amount: { category_id, start_month, amount_cents }.
// All of them, not one month's: there are only a few per category, and
// budget.js picks the one that applies to the month on screen.
export function listBudgetPlans() {
  return db.prepare('SELECT category_id, start_month, amount_cents FROM budget_plans').all();
}

// One month's one-off amounts: { category_id, month, amount_cents }.
export function listBudgetOverrides(month) {
  return db.prepare('SELECT category_id, month, amount_cents FROM budget_overrides WHERE month = ?').all(month);
}

// "From this month on, plan this amount." Saved as a standing amount starting
// in fromMonth (replacing one that already starts there). Because it means
// "this month and every month after", it also:
//   - removes standing amounts that start later (they would otherwise win
//     in those later months), and
//   - removes this month's own override, so the amount typed is the amount
//     shown.
// Overrides in later months are kept: each is a deliberate one-off.
export function setStandingPlan({ categoryId, fromMonth, amountCents }) {
  allOrNothing(() => {
    db.prepare('DELETE FROM budget_plans WHERE category_id = ? AND start_month > ?').run(categoryId, fromMonth);
    db.prepare('DELETE FROM budget_overrides WHERE category_id = ? AND month = ?').run(categoryId, fromMonth);
    // "ON CONFLICT ... DO UPDATE": insert, or update the row already there.
    db.prepare(
      `INSERT INTO budget_plans (category_id, start_month, amount_cents) VALUES (?, ?, ?)
       ON CONFLICT (category_id, start_month) DO UPDATE SET amount_cents = excluded.amount_cents`
    ).run(categoryId, fromMonth, amountCents);
  });
}

// "This month only": an amount for one month that beats the standing amount.
export function setMonthOverride({ categoryId, month, amountCents }) {
  db.prepare(
    `INSERT INTO budget_overrides (category_id, month, amount_cents) VALUES (?, ?, ?)
     ON CONFLICT (category_id, month) DO UPDATE SET amount_cents = excluded.amount_cents`
  ).run(categoryId, month, amountCents);
}

// Removes a one-month amount, so the standing amount applies again.
export function clearMonthOverride(categoryId, month) {
  db.prepare('DELETE FROM budget_overrides WHERE category_id = ? AND month = ?').run(categoryId, month);
}

// --- Payees ---

// Payees for autocomplete, alphabetically, with the category to fill in
// automatically when one is chosen, and the payee's amount rule if it has
// one (threshold_cents etc. are null otherwise).
export function listPayees() {
  return db
    .prepare(
      `SELECT p.id, p.name, p.default_category_id,
              a.threshold_cents, a.below_category_id, a.otherwise_category_id
         FROM payees p
         LEFT JOIN payee_amount_rules a ON a.payee_id = p.id
        WHERE p.is_hidden = 0
        ORDER BY p.name`
    )
    .all();
}

// Every payee, hidden ones too, with how many transactions use each, for the
// Payees screen.
export function listPayeesWithUsage() {
  return db
    .prepare(
      `SELECT p.id, p.name, p.default_category_id, p.is_hidden, COUNT(t.id) AS use_count,
              a.threshold_cents, a.below_category_id, a.otherwise_category_id
         FROM payees p
         LEFT JOIN transactions t ON t.payee_id = p.id
         LEFT JOIN payee_amount_rules a ON a.payee_id = p.id
        GROUP BY p.id
        ORDER BY p.name`
    )
    .all();
}

export function getPayee(id) {
  return db.prepare('SELECT id, name, default_category_id, is_hidden FROM payees WHERE id = ?').get(id);
}

// True if a different payee already has this name. The name column ignores
// capitalization (schema.sql), so "pg&e" counts as taken by "PG&E".
export function payeeNameTaken(name, exceptId = 0) {
  return Boolean(db.prepare('SELECT 1 FROM payees WHERE name = ? AND id != ?').get(name, exceptId));
}

// The functions below return true if a payee with that id existed.

export function renamePayee(id, name) {
  return db.prepare('UPDATE payees SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export function setPayeeHidden(id, isHidden) {
  return db.prepare('UPDATE payees SET is_hidden = ? WHERE id = ?').run(isHidden ? 1 : 0, id).changes > 0;
}

// categoryId may be null to clear the default.
export function setPayeeDefaultCategory(id, categoryId) {
  return (
    db.prepare('UPDATE payees SET default_category_id = ? WHERE id = ?').run(categoryId, id).changes > 0
  );
}

// Folds payees into another, for near-duplicates like "Corner Mkt" and
// "Corner Market", or the many raw bank names a big import creates
// ("CORNER MKT #12 FREEHOLD"). Everything that pointed at each of `fromIds`
// is moved to `intoId`, then those payees are deleted.
//
// With rememberNames, each merged payee's name is also saved as an "is
// exactly" import rule for the kept payee. A payee that came from raw bank
// text would otherwise be created again by the next import with that text.
//
// All or nothing: a failure part-way leaves every payee exactly as it was.
// Returns { moved, rulesAdded }: transactions moved and rules added.
export function mergePayees(fromIds, intoId, { rememberNames = false } = {}) {
  return allOrNothing(() => {
    let moved = 0;
    let rulesAdded = 0;
    for (const fromId of fromIds) {
      moved += db
        .prepare('UPDATE transactions SET payee_id = ? WHERE payee_id = ?')
        .run(intoId, fromId).changes;
      // Import rules should now produce the kept payee.
      db.prepare('UPDATE payee_rules SET payee_id = ? WHERE payee_id = ?').run(intoId, fromId);
      // Keep the merged payee's default category only if the kept one has none.
      db.prepare(
        `UPDATE payees
            SET default_category_id = (SELECT default_category_id FROM payees WHERE id = ?)
          WHERE id = ? AND default_category_id IS NULL`
      ).run(fromId, intoId);
      // The kept payee takes the merged one's amount rule only if it has
      // none of its own; otherwise the merged one's is dropped.
      db.prepare('UPDATE OR IGNORE payee_amount_rules SET payee_id = ? WHERE payee_id = ?').run(intoId, fromId);
      db.prepare('DELETE FROM payee_amount_rules WHERE payee_id = ?').run(fromId);
      if (rememberNames) {
        const { name } = db.prepare('SELECT name FROM payees WHERE id = ?').get(fromId);
        addPayeeRule({ matchType: 'exact', pattern: name, payeeId: intoId });
        rulesAdded++;
      }
      db.prepare('DELETE FROM payees WHERE id = ?').run(fromId);
    }
    return { moved, rulesAdded };
  });
}

// --- Amount rules (one payee, two categories, told apart by amount) ---

// A payee's amount rule, or undefined if it has none.
export function getAmountRule(payeeId) {
  return db
    .prepare(
      `SELECT payee_id, threshold_cents, below_category_id, otherwise_category_id
         FROM payee_amount_rules WHERE payee_id = ?`
    )
    .get(payeeId);
}

// Adds a payee's amount rule, or replaces the one it has.
export function setAmountRule({ payeeId, thresholdCents, belowCategoryId, otherwiseCategoryId }) {
  db.prepare(
    `INSERT OR REPLACE INTO payee_amount_rules
       (payee_id, threshold_cents, below_category_id, otherwise_category_id)
     VALUES (?, ?, ?, ?)`
  ).run(payeeId, thresholdCents, belowCategoryId, otherwiseCategoryId);
}

export function deleteAmountRule(payeeId) {
  return db.prepare('DELETE FROM payee_amount_rules WHERE payee_id = ?').run(payeeId).changes > 0;
}

// Names of the payees whose amount rule uses a category, so deleting that
// category can be refused with a useful message.
export function payeesWithAmountRuleUsing(categoryId) {
  return db
    .prepare(
      `SELECT p.name FROM payee_amount_rules a JOIN payees p ON p.id = a.payee_id
        WHERE a.below_category_id = ? OR a.otherwise_category_id = ?
        ORDER BY p.name`
    )
    .all(categoryId, categoryId)
    .map((row) => row.name);
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

// Transfers: money moving between two of your own accounts (paying the card
// from checking, moving money to savings). A transfer is two ordinary rows,
// one in each account, with opposite amounts, each row's transfer_id holding
// the other row's id. Transfers have no category: they aren't income or
// spending, so reports leave them out.

// One transaction, or undefined if there's no transaction with that id.
export function getTransaction(id) {
  return db
    .prepare('SELECT id, account_id, date, amount_cents, status, transfer_id FROM transactions WHERE id = ?')
    .get(id);
}

// bankDescription and importHash are only set for rows imported from a bank
// file (see importTransactions).
function insertTransaction({
  accountId, date, amountCents, payeeId, categoryId, memo, checkNumber, status,
  bankDescription = null, importHash = null,
}) {
  const result = db
    .prepare(
      `INSERT INTO transactions
         (account_id, date, amount_cents, payee_id, category_id, memo, check_number, status,
          bank_description, import_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, date, amountCents, payeeId, categoryId, memo, checkNumber, status, bankDescription, importHash);
  return Number(result.lastInsertRowid);
}

// --- Importing bank downloads ---

// The fingerprints of every row already imported into an account, so a new
// download can skip the rows it shares with an earlier one.
export function importedFingerprints(accountId) {
  const rows = db
    .prepare('SELECT import_hash FROM transactions WHERE account_id = ? AND import_hash IS NOT NULL')
    .all(accountId);
  return new Set(rows.map((r) => r.import_hash));
}

// The payee with this exact name (ignoring capitals), or undefined.
export function findPayeeByName(name) {
  return db.prepare('SELECT id, name, default_category_id FROM payees WHERE name = ?').get(name);
}

// Rows you entered by hand in `accountId` that an import row may be the
// bank's copy of: same amount, not yet cleared, not themselves imported,
// dated within `days` days. Best first: a matching check number, then the
// closest date.
export function findHandEnteredMatches({ accountId, amountCents, date, checkNumber }, days = 5) {
  return db
    .prepare(
      `SELECT t.id, t.date, t.amount_cents, t.check_number, t.memo, p.name AS payee
         FROM transactions t
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.account_id = ? AND t.amount_cents = ? AND t.status = 'uncleared'
          AND t.import_hash IS NULL
          AND ABS(julianday(t.date) - julianday(?)) <= ?
        ORDER BY (t.check_number IS NOT NULL AND t.check_number = ?) DESC,
                 ABS(julianday(t.date) - julianday(?)), t.id`
    )
    .all(accountId, amountCents, date, days, checkNumber ?? '', date);
}

// Adds imported rows to an account, all or nothing: if any row fails,
// nothing changes. Each row is { date, amountCents, payeeName, categoryId,
// memo, checkNumber, bankDescription, fingerprint } plus optionally:
//   handEnteredId - the bank's copy of a row you entered by hand: instead of
//                   adding a new row, that row is marked cleared and given
//                   the bank's text. Your payee and category are kept.
//   linkToId      - the other half of a transfer, already in another
//                   account: the new row is linked to it.
//   rule          - { pattern } to remember: bank text containing it gets
//                   this row's payee on future imports.
// Imported rows are marked cleared, since the bank has already processed them.
// Returns counts: { added, matched, linked, rules }.
export function importTransactions(accountId, rows) {
  return allOrNothing(() => {
    const counts = { added: 0, matched: 0, linked: 0, rules: 0 };

    for (const row of rows) {
      if (row.handEnteredId) {
        db.prepare(
          `UPDATE transactions
              SET status = 'cleared', bank_description = ?, import_hash = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(row.bankDescription, row.fingerprint, row.handEnteredId);
        counts.matched++;
        continue;
      }

      const payeeId = row.payeeName ? findOrCreatePayee(row.payeeName) : null;
      const id = insertTransaction({
        accountId,
        date: row.date,
        amountCents: row.amountCents,
        payeeId,
        categoryId: row.linkToId ? null : row.categoryId,
        memo: row.memo,
        checkNumber: row.checkNumber,
        status: 'cleared',
        bankDescription: row.bankDescription,
        importHash: row.fingerprint,
      });
      counts.added++;

      if (row.linkToId) {
        pairAsTransfer(id, row.linkToId);
        counts.linked++;
      } else {
        rememberPayeeCategory(payeeId, row.categoryId);
      }

      if (row.rule && payeeId) {
        addPayeeRule({ matchType: 'contains', pattern: row.rule.pattern, payeeId });
        counts.rules++;
      }
    }
    return counts;
  });
}

// --- Payee rules ---

// Every rule, with the name and usual category of the payee it produces.
export function listPayeeRules() {
  return db
    .prepare(
      `SELECT r.id, r.match_type, r.pattern, r.payee_id,
              p.name AS payee_name, p.default_category_id
         FROM payee_rules r
         JOIN payees p ON p.id = r.payee_id
        ORDER BY p.name, r.pattern`
    )
    .all();
}

// Every distinct bank text among imported rows, with how many rows have it
// and the payee(s) those rows ended up with. Used to show what each rule
// matches (see ruleMatches in rules.js).
export function importedDescriptions() {
  return db
    .prepare(
      `SELECT t.bank_description, COUNT(*) AS count, group_concat(DISTINCT p.name) AS payees
         FROM transactions t
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.bank_description IS NOT NULL
        GROUP BY t.bank_description
        ORDER BY t.bank_description`
    )
    .all();
}

// --- Re-applying rules to rows already imported ---

// Imported rows that still have no category, for re-applying today's rules
// to their saved bank text (see proposeRuleResults in rules.js). Left out:
// transfers (no category on purpose) and rows in closed accounts (read-only).
export function uncategorizedImportedRows() {
  return db
    .prepare(
      `SELECT t.id, a.name AS account, t.date, t.amount_cents, t.status, t.bank_description,
              t.payee_id, p.name AS payee, p.default_category_id AS payee_default_category_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.bank_description IS NOT NULL AND t.category_id IS NULL
          AND t.transfer_id IS NULL AND a.is_closed = 0
        ORDER BY a.name, t.date, t.id`
    )
    .all();
}

// Sets the payee and category of several rows, all or nothing. Each change is
// { id, payeeId, categoryId }. The WHERE repeats "uncategorized, not a
// transfer", so a row you categorized after the preview is left alone
// rather than overwritten. Returns how many rows changed.
//
// The payee's remembered category isn't updated (as saving a transaction
// does), because these categories came from the payee in the first place.
export function applyRuleResults(changes) {
  return allOrNothing(() => {
    const update = db.prepare(
      `UPDATE transactions SET payee_id = ?, category_id = ?, updated_at = datetime('now')
        WHERE id = ? AND category_id IS NULL AND transfer_id IS NULL`
    );
    let updated = 0;
    for (const change of changes) {
      updated += update.run(change.payeeId, change.categoryId, change.id).changes;
    }
    return updated;
  });
}

// Adds a rule, or, if the same kind of rule with the same pattern already
// exists (ignoring capitals), points it at this payee instead of making a
// second, conflicting one.
export function addPayeeRule({ matchType, pattern, payeeId }) {
  const existing = db
    .prepare('SELECT id FROM payee_rules WHERE match_type = ? AND pattern = ? COLLATE NOCASE')
    .get(matchType, pattern);
  if (existing) {
    db.prepare('UPDATE payee_rules SET payee_id = ? WHERE id = ?').run(payeeId, existing.id);
  } else {
    db.prepare('INSERT INTO payee_rules (match_type, pattern, payee_id) VALUES (?, ?, ?)').run(
      matchType,
      pattern,
      payeeId
    );
  }
}

// True if a different rule already has this kind and pattern (ignoring
// capitals). Two such rules would fight over the same bank text.
export function payeeRuleTaken({ matchType, pattern }, exceptId = null) {
  const row = db
    .prepare('SELECT id FROM payee_rules WHERE match_type = ? AND pattern = ? COLLATE NOCASE AND id IS NOT ?')
    .get(matchType, pattern, exceptId);
  return row !== undefined;
}

// Changes a rule. It affects future imports only; transactions already
// imported keep their payee.
export function updatePayeeRule({ id, matchType, pattern, payeeId }) {
  return (
    db
      .prepare('UPDATE payee_rules SET match_type = ?, pattern = ?, payee_id = ? WHERE id = ?')
      .run(matchType, pattern, payeeId, id).changes > 0
  );
}

export function deletePayeeRule(id) {
  return db.prepare('DELETE FROM payee_rules WHERE id = ?').run(id).changes > 0;
}

// --- Backups ---

// Writes a complete copy of the open database to `filePath` (which must not
// exist yet). VACUUM INTO is SQLite's own way of copying a database safely,
// even while the app has it open.
export function backupTo(filePath) {
  db.prepare('VACUUM INTO ?').run(filePath);
}

// Points two rows at each other as the halves of one transfer, and clears
// their categories (a transfer isn't income or spending).
function pairAsTransfer(idA, idB) {
  const link = db.prepare('UPDATE transactions SET transfer_id = ?, category_id = NULL WHERE id = ?');
  link.run(idB, idA);
  link.run(idA, idB);
}

// Creates the other half of a transfer in `otherAccountId`: same date, payee
// and memo, opposite amount, not yet cleared (the other bank hasn't
// necessarily processed it). Returns its id.
function createTransferPartner(id, otherAccountId) {
  const row = db
    .prepare('SELECT date, amount_cents, payee_id, memo FROM transactions WHERE id = ?')
    .get(id);
  const partnerId = insertTransaction({
    accountId: otherAccountId,
    date: row.date,
    amountCents: -row.amount_cents,
    payeeId: row.payee_id,
    categoryId: null,
    memo: row.memo,
    checkNumber: null,
    status: 'uncleared',
  });
  pairAsTransfer(id, partnerId);
  return partnerId;
}

// Adds a transaction and returns its new id. amountCents is signed:
// positive = money in, negative = money out. payeeName is plain text; the
// matching payee is looked up or created here. categoryId may be null
// (uncategorized). With transferAccountId (instead of a category), the other
// half of a transfer is created in that account too, all or nothing.
export function createTransaction({
  accountId,
  date,
  amountCents,
  payeeName = null,
  categoryId = null,
  transferAccountId = null,
  memo = null,
  checkNumber = null,
  status = 'uncleared',
}) {
  return allOrNothing(() => {
    const payeeId = payeeName ? findOrCreatePayee(payeeName) : null;
    const id = insertTransaction({ accountId, date, amountCents, payeeId, categoryId, memo, checkNumber, status });
    if (transferAccountId) {
      createTransferPartner(id, transferAccountId);
    } else {
      rememberPayeeCategory(payeeId, categoryId);
    }
    return id;
  });
}

// Changes the fields you can edit in the register. Status is left as it is
// (it has its own controls). Returns false if there's no transaction with that id.
//
// For a transfer (transferAccountId set), the other half is kept in step:
//   - its amount always mirrors this one (-500 here means +500 there);
//   - it moves to transferAccountId if you pointed the transfer elsewhere;
//   - its date follows this one only if the two dates matched before, so a
//     bank-imported other half keeps the date that bank gave it.
// A plain transaction given a transferAccountId becomes a transfer, and its
// other half is created. (Turning a transfer back into a plain transaction is
// done with unlinkTransfer, so the other half is never silently lost.)
export function updateTransaction(
  id,
  { date, amountCents, payeeName = null, categoryId = null, transferAccountId = null, memo = null, checkNumber = null }
) {
  return allOrNothing(() => {
    // Check first, so a missing transaction doesn't leave a new payee behind.
    const before = getTransaction(id);
    if (!before) return false;

    const payeeId = payeeName ? findOrCreatePayee(payeeName) : null;
    db.prepare(
      `UPDATE transactions
          SET date = ?, amount_cents = ?, payee_id = ?, category_id = ?, memo = ?, check_number = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(date, amountCents, payeeId, transferAccountId ? null : categoryId, memo, checkNumber, id);

    if (!transferAccountId) {
      rememberPayeeCategory(payeeId, categoryId);
    } else if (before.transfer_id === null) {
      createTransferPartner(id, transferAccountId);
    } else {
      const partner = getTransaction(before.transfer_id);
      db.prepare(
        `UPDATE transactions
            SET amount_cents = ?, account_id = ?, date = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(-amountCents, transferAccountId, partner.date === before.date ? date : partner.date, partner.id);
    }
    return true;
  });
}

// Joins two existing rows into one transfer, e.g. a checking withdrawal and
// the card payment that both arrived by CSV import. The server checks they're
// in different accounts, have opposite amounts, and aren't transfers already.
export function linkTransfer(idA, idB) {
  allOrNothing(() => pairAsTransfer(idA, idB));
}

// Splits a transfer back into two ordinary (uncategorized) rows. Nothing is
// deleted. Returns false if the row isn't part of a transfer.
export function unlinkTransfer(id) {
  const row = getTransaction(id);
  if (!row || row.transfer_id === null) return false;
  db.prepare('UPDATE transactions SET transfer_id = NULL WHERE id IN (?, ?)').run(id, row.transfer_id);
  return true;
}

// Rows in other accounts that could be the other half of this one: the
// opposite amount, not already part of a transfer, dated within `days` days.
// Closest dates first.
export function findTransferCandidates(id, days = 7) {
  const row = getTransaction(id);
  return findTransferCandidatesFor(
    { accountId: row.account_id, amountCents: row.amount_cents, date: row.date },
    days
  );
}

// The same search for a row that isn't saved yet (a row in an import file):
// rows outside `accountId` with the opposite of `amountCents`, near `date`.
export function findTransferCandidatesFor({ accountId, amountCents, date }, days = 7) {
  return db
    .prepare(
      `SELECT t.id, t.date, t.amount_cents, t.memo, t.status, a.name AS account, p.name AS payee
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.account_id != ? AND t.amount_cents = ? AND t.transfer_id IS NULL
          AND ABS(julianday(t.date) - julianday(?)) <= ?
        ORDER BY ABS(julianday(t.date) - julianday(?)), t.id`
    )
    .all(accountId, -amountCents, date, days, date);
}

// status is 'uncleared', 'cleared' or 'reconciled' (the server checks).
export function setTransactionStatus(id, status) {
  return (
    db
      .prepare(`UPDATE transactions SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id).changes > 0
  );
}

// Locks in everything currently cleared in one account, once you've checked
// the cleared balance against the bank. Returns how many rows changed.
export function reconcileCleared(accountId) {
  return db
    .prepare(
      `UPDATE transactions SET status = 'reconciled', updated_at = datetime('now')
        WHERE account_id = ? AND status = 'cleared'`
    )
    .run(accountId).changes;
}

// Removes a transaction. For a transfer both halves go, since one half on its
// own would leave money appearing or vanishing. The page says so and asks first.
export function deleteTransaction(id) {
  return allOrNothing(() => {
    const row = getTransaction(id);
    if (!row) return false;
    db.prepare('DELETE FROM transactions WHERE id IN (?, ?)').run(id, row.transfer_id);
    return true;
  });
}

// One account's transactions in register order: by date, and within the same
// date by id (the order they were entered). That ordering is what makes the
// running balance come out the same every time.
//
// Payee and category names are looked up by joining their tables. LEFT JOIN
// keeps a transaction even when it has no payee or category yet (name = null).
// The category is shown as "Group: Sub", so the categories table is joined a
// second time (as "g") to get the sub's group name. For a transfer, the other
// half (pt) and its account (pa) are joined to show "Transfer: <account>".
export function getRegister(accountId) {
  return db
    .prepare(
      `SELECT t.id, t.date, t.check_number, t.memo, t.amount_cents, t.status,
              p.name AS payee, t.category_id, g.name || ': ' || c.name AS category,
              g.name AS category_group, c.name AS category_name,
              t.transfer_id, pt.account_id AS transfer_account_id,
              pa.name AS transfer_account, pt.status AS transfer_status
         FROM transactions t
         LEFT JOIN payees p ON p.id = t.payee_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN categories g ON g.id = c.parent_id
         LEFT JOIN transactions pt ON pt.id = t.transfer_id
         LEFT JOIN accounts pa ON pa.id = pt.account_id
        WHERE t.account_id = ?
        ORDER BY t.date, t.id`
    )
    .all(accountId);
}
