// Upgrade steps for databases made by an earlier version of the app.
//
// Part of the storage layer: only db.js imports this file, so SQL still never
// appears anywhere else in the app.
//
// How versions work: every database file carries a number in its header,
// SQLite's "user_version" (0 until something sets it). A database built fresh
// from schema.sql is stamped with the latest version below. An older file is
// brought up to date by running, in order, each step newer than its number
// (see prepareSchema in db.js), after a backup.
//
// To change the schema (add a table, add a column, change a rule):
//   1. Edit schema.sql, so brand-new databases get the change.
//   2. Add a step at the end of this list, with the next version number, so
//      existing databases (your real one) get the same change.
//   test/schema.test.js checks that both routes end with identical tables.
//
// Recipes for the step itself:
//   - New table: CREATE TABLE, copied from schema.sql.
//   - New column: ALTER TABLE t ADD COLUMN ... (it must allow NULL or have a
//     default, since existing rows need a value).
//   - Anything else (change a column's type or CHECK, drop a column, ...):
//     SQLite can't alter that in place. Make the new table under a new name,
//     copy the rows across, drop the old table, rename the new one. Foreign
//     keys must be switched off around that (PRAGMA foreign_keys can't change
//     inside a transaction) and checked afterwards with
//     PRAGMA foreign_key_check. We'll write the first such step by hand, with
//     a test, when one is needed.

export const MIGRATIONS = [
  {
    // Milestone 11c. Milestone 11c's own start-up check may already have
    // created this table, hence IF NOT EXISTS.
    version: 1,
    about: 'Amount rules per payee',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payee_amount_rules (
          payee_id              INTEGER PRIMARY KEY REFERENCES payees(id),
          threshold_cents       INTEGER NOT NULL CHECK (threshold_cents > 0),
          below_category_id     INTEGER NOT NULL REFERENCES categories(id),
          otherwise_category_id INTEGER NOT NULL REFERENCES categories(id)
        ) STRICT;
      `);
    },
  },
  {
    // Milestone 14b: planned amounts for the Budget screen. Two new, empty
    // tables; no existing row is touched.
    version: 2,
    about: 'Budget planned amounts',
    up(db) {
      db.exec(`
        CREATE TABLE budget_plans (
          category_id  INTEGER NOT NULL REFERENCES categories(id),
          start_month  TEXT    NOT NULL CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
          amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
          PRIMARY KEY (category_id, start_month)
        ) STRICT;
        CREATE TABLE budget_overrides (
          category_id  INTEGER NOT NULL REFERENCES categories(id),
          month        TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
          amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
          PRIMARY KEY (category_id, month)
        ) STRICT;
      `);
    },
  },
];
