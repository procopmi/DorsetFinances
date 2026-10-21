-- The complete, current table definitions. Used only to build a brand-new,
-- empty database (npm run setup, the seed, tests). An existing database is
-- brought up to date by the upgrade steps in migrations.js instead, so any
-- change here needs a matching step there (test/schema.test.js checks).
--
-- "STRICT" tells SQLite to reject a value of the wrong type. By default SQLite
-- would happily store 12.34 in an INTEGER column; STRICT turns that into an
-- error, which enforces the integer-cents rule at the database level too.

-- Bank accounts and credit cards. 'investment' is an account such as a
-- Fidelity money market, tracked by its cash balance only (transfers in and
-- out, dividends); shares, prices and gains are not tracked.
CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT    NOT NULL,
  type                  TEXT    NOT NULL CHECK (type IN ('checking', 'savings', 'credit_card', 'investment')),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_date          TEXT    NOT NULL,            -- 'YYYY-MM-DD'
  is_closed             INTEGER NOT NULL DEFAULT 0,  -- 1 = hidden, history kept
  sort_order            INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Two-level categories in one table. A row with parent_id NULL is a top-level
-- group (Utilities); a row with a parent_id is a sub-category (Electric).
-- Transactions point at sub-categories; reports roll them up via parent_id.
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES categories(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
  is_hidden   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (parent_id, name)
) STRICT;

-- Clean payee names ("PG&E"), used for autocomplete during entry and as the
-- target of import rules. COLLATE NOCASE stops "PG&E" and "pg&e" both existing.
CREATE TABLE IF NOT EXISTS payees (
  id                  INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  default_category_id INTEGER REFERENCES categories(id),
  is_hidden           INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Rules that turn messy bank text ("PGE WEB PYMT 8812") into a payee during
-- CSV import. Plain text matching only, no regular expressions.
CREATE TABLE IF NOT EXISTS payee_rules (
  id          INTEGER PRIMARY KEY,
  match_type  TEXT    NOT NULL CHECK (match_type IN ('contains', 'starts_with', 'exact')),
  pattern     TEXT    NOT NULL,
  payee_id    INTEGER NOT NULL REFERENCES payees(id)
) STRICT;

-- For a payee whose bank text is always the same but whose payments belong
-- to two categories, told apart by size: e.g. a life insurer billing two
-- policies, "under $100.00 -> Life - Cindy, otherwise -> Life - Michael".
-- Used during imports. At most one per payee; the size of the amount is
-- compared, so a refund goes to the same category as the payment.
-- (Added after phase 1, as upgrade step 1 in migrations.js.)
CREATE TABLE IF NOT EXISTS payee_amount_rules (
  payee_id              INTEGER PRIMARY KEY REFERENCES payees(id),
  threshold_cents       INTEGER NOT NULL CHECK (threshold_cents > 0),
  below_category_id     INTEGER NOT NULL REFERENCES categories(id),
  otherwise_category_id INTEGER NOT NULL REFERENCES categories(id)
) STRICT;

-- Budget: standing monthly amounts. Each row says "from start_month on, plan
-- amount_cents a month for this category", so a change from June on leaves
-- January to May as they were. The amount for a month is the row with the
-- latest start_month up to that month (see budget.js). Amounts are positive:
-- expected spending for an expense category, expected income for an income one.
-- (Added in phase 2, as upgrade step 2 in migrations.js.)
CREATE TABLE IF NOT EXISTS budget_plans (
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  start_month  TEXT    NOT NULL CHECK (start_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (category_id, start_month)
) STRICT;

-- Budget: a one-month exception that beats the standing amount, e.g. a bigger
-- Gifts amount in December. (Also upgrade step 2.)
CREATE TABLE IF NOT EXISTS budget_overrides (
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  month        TEXT    NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (category_id, month)
) STRICT;

-- One row per register line. amount_cents is signed from the account's point
-- of view: positive = money in, negative = money out (on a credit card a charge
-- is negative). There is no balance column: the running balance is computed
-- when the register loads, so it can never drift out of sync.
CREATE TABLE IF NOT EXISTS transactions (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id),
  date             TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  payee_id         INTEGER REFERENCES payees(id),
  category_id      INTEGER REFERENCES categories(id),  -- NULL = uncategorized
  memo             TEXT,
  check_number     TEXT,
  amount_cents     INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'uncleared'
                           CHECK (status IN ('uncleared', 'cleared', 'reconciled')),
  transfer_id      INTEGER,  -- for a transfer: the id of the other half (each points at the other)
  bank_description TEXT,     -- original bank text, for imported rows
  import_hash      TEXT,     -- lets a re-import skip rows already imported
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;

-- Speeds up the register query, which always asks for one account's
-- transactions in date order.
CREATE INDEX IF NOT EXISTS transactions_by_account_date
  ON transactions (account_id, date, id);
