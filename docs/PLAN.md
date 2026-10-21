# Dorset Finances: Plan and Decisions

Last updated 2026-10-21, during phase 2 (milestone 14a). **Phase 1 is complete and your real data is live.** See §5 "Budget" for the phase 2 design, §6 for progress and §7 for open decisions.

This file collects what was planned and agreed in chat, so the decisions don't live only in conversation history. `CLAUDE.md` holds the project rules. This file holds the design that grew from them.

**How to read the markers:**
- **No marker:** discussed in chat and approved by you.
- **(recap)** I decided this while building and reported it in a milestone recap. You approved the commit, but we never discussed it on its own. Worth a second look.
- **(code)** I inferred this from the current code. It never came up in chat. Please check it.

Sources: this session's chat, the git log, the current code, and the plan file in `~/.claude/plans/`. There's only one plan file there, and each milestone's plan overwrote the one before. It now holds only the milestone 10 plan, so I recovered the earlier versions from the session transcript. Milestones 2–4 and 7–9 were planned in chat, not in that file.

---

## 1. Stack

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node.js v24 (LTS), `"engines": ">=24"` | Current LTS on your Mac (v24.22.0, npm 11.19.1 at the start) |
| SQLite driver | **Built-in `node:sqlite`** (`DatabaseSync`) | No npm packages and no native build. Node's docs don't yet call it "Stable" (it's at release-candidate), which strictly reads against CLAUDE.md's "if it is stable". You approved it anyway. Switching to `better-sqlite3` later would touch only `db.js` |
| Web server | Plain `node:http` with a small route table. **No Express** | Keeps us at zero dependencies |
| Modules | ES modules (`import`/`export`) | Current Node standard |
| Frontend | Plain HTML/CSS/JS, no framework, no build step | Per CLAUDE.md |
| npm dependencies | **None** | |
| Network | Listens on `127.0.0.1:3000` only | Per CLAUDE.md |
| Tests | `node --test`, money math and CSV only, in-memory databases | Per CLAUDE.md. 88 tests at present |

**Safety additions beyond CLAUDE.md:**
- **(recap)** `isTrustedRequest` refuses any request whose Host isn't `127.0.0.1:3000` or `localhost:3000`, and any POST that isn't JSON. This stops other websites open in your browser from changing your data (DNS rebinding / CSRF).
- **(recap)** Static files can't be read from outside `public/`.
- **(recap)** Request bodies are capped at 10 million characters.

## 2. Project structure

```
package.json          scripts only; no dependencies
.env.example          FINANCE_DB=/Users/<you>/FinanceData/finance.db  (real .env is gitignored)
.claude/settings.json deny/ask rules for Claude (committed)
src/
  config.js           the one place that decides which database opens (--demo flag vs FINANCE_DB)
  db.js               THE ONLY FILE THAT TALKS TO SQLITE
  schema.sql          the full, current table definitions (for brand-new databases)
  migrations.js       upgrade steps for older databases (imported only by db.js)
  money.js            cents parsing/formatting, running and cleared balances (shared with the browser)
  budget.js           the Budget screen's math (actuals per category, group and section totals)
  csv.js              CSV export and bank-file parsing
  rules.js            payee-rule matching and pattern suggestion
  default-categories.js  the approved category list as data
  backup.js           timestamped backups (VACUUM INTO)
  server.js           routes, input checks, request guard
public/               index.html, styles.css, main.js (screen switcher), api.js (shared helpers),
                      register.js, budget.js, categories.js, payees.js, import.js
scripts/              seed-sample.js, setup-real.js, backup.js
test/                 money, balances, transfers, csv, rules, import, reapply, schema, budget
sample-data/          sample.db and backups/ (generated, gitignored)
```

- **The page never runs SQL.** The browser calls the server, the server calls functions in `db.js`, and only `db.js` touches SQLite. (A grep at milestone 10 confirmed SQL appears only in `db.js` and `schema.sql`.)
- **Route style (recap):** `'METHOD /path'` → handler. Ids travel in the JSON body; GET routes read query parameters.

## 3. Data location and modes (milestone 10)

- **Real data:** `~/FinanceData/finance.db`, outside the repo. The empty in-project `./FinanceData/` folder was removed at the start.
- **Backups:** a `backups/` folder next to whichever database is open, so real backups go to `~/FinanceData/backups/`.
- **`npm start` opens real data** and `npm run start:demo` opens sample data. You asked for this order; my original plan had it the other way round, with `start:real`.
- **`config.js` refuses to start in real mode if:**
  - `FINANCE_DB` isn't set,
  - it isn't a full path,
  - its folder doesn't exist, or
  - the file is missing (only `npm run setup` may start without the file).
- **`npm run setup`** creates the real database with the default categories. It refuses if the file already exists.
- **Claude's limits** (`.claude/settings.json`):
  - Claude can't read or edit `~/FinanceData/**` or `./.env`.
  - Claude can't run `npm start`, `npm run setup` or `npm run backup`.
  - `rm` needs your approval each time.

## 4. Data model

Every table is `STRICT`, so SQLite itself refuses a decimal in a cents column or a badly formed date. Dates are stored as `'YYYY-MM-DD'` text. Foreign keys are on.

| Table | Key points |
|---|---|
| `accounts` | `type`: checking / savings / credit_card / investment. Also `opening_balance_cents`, `opening_date`, `is_closed` (hides the account and makes it read-only, keeping its history) and `sort_order` |
| `categories` | One table, two levels: `parent_id` NULL = group, set = sub. `kind` income/expense, `is_hidden`, `sort_order`, names `UNIQUE(parent_id, name)` |
| `payees` | `name` unique, ignoring capitals; `default_category_id`; `is_hidden` |
| `payee_rules` | `match_type` contains / starts_with / exact, `pattern`, `payee_id`. Plain text, no regex |
| `payee_amount_rules` | (milestone 11c) One per payee: `threshold_cents`, `below_category_id`, `otherwise_category_id`. Under the threshold (by size, sign ignored) → first category, otherwise → second |
| `transactions` | `account_id`, `date`, `payee_id`, `category_id` (NULL = uncategorized), `memo`, `check_number`, signed `amount_cents`, `status`, `transfer_id`, `bank_description`, `import_hash`, `created_at`, `updated_at` |

**Money rules:**
- `amount_cents` is signed from the account's point of view: **+ means money in, − means money out**.
- On a credit card a charge is negative, so a **negative card balance means money owed**.
- **The running balance is never stored.** It's computed on each load from the opening balance, in (date, id) order.
- **Cleared balance** = opening balance + cleared and reconciled items.

**Categories:**
- Transactions can only use **sub-categories**. Groups exist for roll-up reports.
- **(recap)** Hidden categories can still be saved on a transaction, so old rows stay editable. Hiding only removes a category from the suggestions. (The milestone 5 plan said they'd be refused.)
- Unknown category text is refused, never created automatically. Payees, by contrast, are created as you type.

**Transfers:**
- Each half's `transfer_id` holds the **other** half's id. (The first plan said both halves would share one value. That changed in milestone 7.)
- Transfers have no category and will be **left out of spending reports**.

**Splits:** deferred. `category_id` stays on `transactions`. Adding splits later would mean a `transaction_splits` table and a mechanical migration (one split row per transaction). **You asked to be consulted before splits are built.**

## 5. Feature decisions by area

### Register (milestones 3, 4 and 6)
- **Two amount columns, stored as one signed number.**
  - Checking and savings show Payment | Deposit.
  - Credit cards show Charge | Payment.
  - Investment accounts show Withdrawal | Deposit.
- **Keyboard entry:**
  - A blank entry row at the bottom. Tab moves between fields, Enter saves, Esc cancels.
  - The date starts as the last date you entered.
  - Shift+Tab reaches the list, where ↑/↓ move, Enter edits, Delete removes (after asking) and Space toggles cleared.
- **Payee box:**
  - Suggests existing payees and creates new ones on save.
  - Picking a payee fills its default category, which is the **last category used with that payee**.
  - You said: "Payee entering is fine for now."
- **"Fill last amount" was deliberately left out.**
- **(recap)** **Rename uses the browser's plain prompt box, and delete uses its confirm box.** Nicer dialogs could come later.
- **Reconciling: no statement-based reconciliation (your decision).**
  - Click Clr or press Space to toggle cleared (`c`).
  - The header shows Balance and Cleared side by side.
  - **Mark cleared as reconciled** locks every `c` row as `R`.
  - Editing, deleting or unclearing an `R` row asks first.
  - The planned statement panel and `reconciliations` table were dropped.

### Categories and payees (milestone 5)
- **The category list (approved 2026-10-16)** lives in `src/default-categories.js`: 17 groups and 67 subs.
  - It started at 65 subs. Milestone 9.0 added Other Income: Dividends and Other: Cash.
  - Groups are by **purpose**, not by how often something is paid. Vendor names are payees, not categories.
- **Answers to the category questions:**
  - Utilities: Gas means natural gas for the house; car fuel is Auto: Fuel.
  - Property tax and homeowners insurance are escrowed in Mortgage, so they have no subs of their own.
  - Subscriptions has two broad subs; the payee names the service.
  - Paychecks are recorded as the **net** deposit.
  - Other Income: Repayments was added for money paid back to you (for example, a Zelle for a shared dinner).
- **Not categories:**
  - transfers between your own accounts;
  - purchase refunds, which go back to the original category.
- **Management screens:**
  - Categories: add, rename, hide, move a sub to another group (it takes on the new group's income/expense kind), and delete. Delete works only when nothing uses the category; otherwise hide it.
  - Payees: rename, hide, set the default category, **merge** (moves transactions and rules, and always asks first), and view or delete import rules.
- **Milestone 11 additions (Payees screen):**
  - **Import rules** can be edited (kind, text, payee) and added, not just deleted. Each shows how many imported rows it would pick; click the count to list the bank text. A text counts only for the rule that wins it, so a 0 means a rule does nothing. Rule changes affect future imports only.
  - **A filter box** narrows payees by name or rule text.
  - **Merge several at once:** tick payees (or tick all shown), then "Merge into". A "Remember names for imports" tickbox, on by default, saves each merged name as an "is exactly" rule for the kept payee, so the next import doesn't recreate it.
  - **Amount rule** ("under $X → A, otherwise → B"), for one payee billing two things with the same bank text (your life insurance). Used by the import preview, where it beats the default category, and (since 12b) by register entry: as you type the amount, the category switches to the rule's choice, unless you typed or picked a category yourself. Changing the amount of an old row doesn't change its saved category. When merging, the kept payee keeps its own amount rule, or takes the first merged one's; others are removed. A category used by an amount rule can't be deleted.
- **Milestone 13: apply rules to rows already imported.**
  - Re-importing a file can't fix early imports, because every row is already imported and is skipped as a duplicate.
  - Instead, "Apply rules to uncategorized rows…" on the Payees screen runs today's rules on the bank text saved with each imported row.
  - It sets the rule's payee, and the category from the amount rule or the payee's usual category.
  - **Only uncategorized rows** are offered (your choice), and the payee is set too.
  - Left out: transfers and rows in closed accounts.
  - Preview first, then a backup (`…-reapply-rules.db`), then all-or-nothing. A row you categorize after the preview is skipped, not overwritten.
- **Payee approach (your question, answered):** a `payees` table for quick entry with default categories, plus `payee_rules` that map bank text to payees at import. **CSV files are never cleaned by hand.**

### Transfers (milestone 7)
- **Two ways in, and you approved both:**
  - typing `Transfer: <account>` in Category creates the other half;
  - **Link…** joins two existing rows with opposite amounts in another account, dated within **7 days**.
- **What syncs between the halves:**
  - The amount always stays mirrored.
  - The date syncs only if both halves had the same date, so linked bank rows keep the bank's dates.
  - Payee and memo don't sync.
- **Deleting, unlinking and editing:**
  - Deleting one half deletes both, after asking.
  - **Unlink** keeps both rows as ordinary transactions.
  - Turning a transfer into an ordinary row by editing is refused with "Use Unlink first".
- **Closed accounts** can't be the target of a new transfer.

### CSV export (milestone 8)
- **Columns:** Date, Account, Num, Payee, Category Group, Category, Memo, Amount, Status, Balance.
- **Amounts** are plain numbers like `-1234.56`.
- **Scope:** one account or all accounts, with an optional From/To range. Balances count history from before the range.
- **(recap) File details:**
  - A UTF-8 marker at the start, so Excel shows accented and curly characters correctly.
  - A formula guard: text starting with `= + - @` gets a leading `'`, so a spreadsheet treats it as text.

### CSV import (milestone 9)
- **Your bank and file formats:**
  - **All accounts are at Chase**, for both of you. Two formats are built in and recognised by their header line, so there's no column-mapping screen.
  - **Checking/savings files** have Posting Date in M/D/YY form, an extra empty column at the end of each row, and the bank's running Balance.
  - **Card files:** the app uses the **Transaction Date** (your choice), and turns `&amp;`-style codes into the plain characters.
  - Chase's signs already match ours, so nothing is flipped.
- **How the import works:**
  - **Preview first, then commit.** The commit re-reads the file itself, **makes a backup first**, and imports the rows as **cleared**, all-or-nothing.
  - **Duplicates** are found by a fingerprint per row (the files have no transaction IDs) and skipped.
- **The bank's own card category** is shown as a hint only (your choice).
- **Other choices you made:**
  - Cash withdrawals go to **Other: Cash**.
  - Fidelity is an **investment** account type that tracks the cash balance only. Dividends are recorded under Other Income: Dividends. Because the money market reinvests at $1 a share, the dividend deposit is the only entry needed. Shares and prices aren't tracked (out of scope).
- **Milestone 9b additions:**
  - **Remembered payee rules.** Rules made from the preview are always "contains" rules (recap). When several rules match, the most specific wins: exact, then starts with, then contains, then the longer pattern.
  - **Linking transfers during import**, offered only when there's exactly one match.
  - **Matching rows you entered by hand.** The import row must have the same amount and be within **5 days** of an uncleared row you entered by hand that hasn't been imported; a matching check number ranks first. Your row is then marked cleared instead of a duplicate being added.
  - **Bank-balance check:** after a checking/savings import, the bank's balance is shown next to your cleared balance.
- **(recap)** The hand-entry match also finds the uncleared half of a transfer you entered yourself.
- **(recap)** Each existing row can be matched only once per file.

### Budget (phase 2, planned 2026-10-21)
- **Your answers to the model questions:**
  - **Simple monthly** budget, with no carryover: each month starts fresh. Envelopes stay possible later.
  - **Standing amount + overrides.** A monthly amount is set once and applies to every month until you change it. Any single month can be overridden.
  - **Income is budgeted too**, planned vs. actual, so the screen shows a planned net and an actual net.
  - **Recurring / other flag** per category, with subtotals (the idea from your old spreadsheet).
- **How "actual" is counted (proposed in the plan, approved with it):**
  - Transactions in a sub-category dated in that month, from **all accounts** (closed ones included), whatever their cleared status.
  - **Both sections show positive numbers:** income is money in, expenses are money spent. A refund lowers its category's spending.
  - **Transfers are left out.** A card charge counts when charged, and the card payment is a transfer.
  - **Uncategorized** rows show as their own line in each section (money in under Income, money out under Expenses), so the totals match the registers.
  - Hidden categories appear only in a month where they have money (or, from 14b, a plan).
- **Planned amounts (14b):**
  - Stored as whole positive cents. Standing amounts have a start month, so a change from June on doesn't rewrite earlier months.
  - A toggle chooses whether an edit applies to "this month and later" (the default) or "this month only".
  - Difference column: positive is good in both sections (expenses: planned − actual; income: actual − planned).
- **Schema plan:** v2 adds `budget_plans` (category, start month, amount) and `budget_overrides` (category, month, amount). v3 adds `categories.is_recurring`. Your real database is backed up and upgraded automatically on the first `npm start` after each.

## 6. Milestones

| # | Milestone | Status | Commit |
|---|---|---|---|
| 1 | Server skeleton, schema, money helpers, empty register | Done | `a0c082f` |
| 2 | Accounts, plus the sample seed script | Done | `a2f2b37` |
| 3 | Read-only register with running balance | Done | `501486e` |
| 4 | Keyboard entry, editing, payees | Done | `a751c9c` |
| 5a | Categories in the register | Done | `985b7bf` |
| 5b | Category and payee management screens | Done | `7f4f30e` |
| 6 | Cleared status, cleared balance, lock as reconciled | Done | `afc487b` |
| 7 | Transfers (enter or link) | Done | `f09eafd` |
| 8 | CSV export | Done | `d2ffe55` |
| 9.0 | Investment account type, Dividends and Cash categories | Done | `442c63b` |
| 9a | CSV import with preview, duplicate skipping, backup | Done | `20aa16d` |
| 9b | Payee rules, transfer linking, hand-entry matching | Done | `e0fc1b6` |
| 10 | Real-data switch-on (`npm start` = real, `start:demo` = sample) | Done | `23810c2` |
| — | This plan doc | Done | `1c9b2ff` |
| — | Clean-up: real rule type in the import preview, one `.app-header` CSS rule, CLAUDE.md tidy and pointer to this file | Done | `f06585f` |
| 11a | Edit, add and review import rules; Payees filter box | Done | `ffcd1b2` |
| 11b | Merge several ticked payees, remembering their names as rules | Done | `eefaed5` |
| 11c | Amount rule per payee; backup before a new table is added | Done | `84a15c6` |
| 12a | Versioned schema upgrades (`user_version` + upgrade steps) | Done | `f745df4` |
| 12b | Amount rule fills the category in register entry | Done | `d8a970a` |
| 13 | Apply rules to uncategorized imported rows (Payees screen) | Done | `1530725` |
| — | **Your real-data setup:** `.env`, `npm run setup`, 6 accounts, categories, imports and rules | Done by you (reported 2026-10-21; some cleanup still going on) | — |
| 14a | Budget screen, read-only: actuals per category by month | Done | (this commit) |
| 14b | Planned amounts: standing + overrides, Difference column, summary (schema v2) | Next | — |
| 14c | Recurring flag and subtotals (schema v3) | Planned | — |
| Phase 3 | Reports and dashboard: spending by category | Not started | — |

### What's next
1. **14b: planned amounts** (see §5 "Budget"). This will upgrade your real database to schema v2 on the next `npm start` after it's committed, with a backup first.
2. Then 14c (recurring flag), then phase 3.

**Browser testing:** I checked every milestone through the API and the tests, but **I have never clicked through the page myself**. Each recap listed browser steps for you to try. Apart from "Payee entering is fine for now", I don't know which ones you ran.

## 7. Open questions and pending decisions

Items 3–5 can wait until real use shows whether they matter.

1. ~~**Phase 2 budget model.**~~ **Settled 2026-10-21:** simple monthly, no carryover, standing amounts with overrides, income budgeted, recurring flag. See §5 "Budget".
2. ~~**How future schema changes reach your real database.**~~ **Settled in milestone 12a:**
   - Each database file records its schema version in SQLite's `user_version`. Every file made before 12a is at version 0; the current version is 1.
   - **On opening** (`openDb` → `prepareSchema` in `db.js`):
     - a file newer than the app is refused, unchanged;
     - an empty file is built from `schema.sql` and stamped as current;
     - an older file is **backed up** (`…-upgrade.db`), then each missing step in `src/migrations.js` runs in order, each all-or-nothing with its version number;
     - a current file is left alone.
   - This happens automatically on `npm start` (your choice), which prints "Upgraded database from version X to Y".
   - **The rule for every schema change:** edit `schema.sql` (for new files) **and** add an upgrade step (for existing files). `test/schema.test.js` checks that both give identical tables, starting from `test/fixtures/schema-v0.sql`. `migrations.js` has the recipes (new table, new column, and the copy-and-rename for anything else).
3. **Split transactions:** deferred. Ask before building them.
4. **Credit card display.** Balances show as negative and red when money is owed. In milestone 3 I offered to show a positive "amount owed" instead. You never answered, so it's unchanged.
5. ~~**Rule types in the UI.**~~ Resolved in milestone 11a: the Payees screen can add and edit all three kinds.
6. **Sample backups.** My test runs left 8 backup files in `sample-data/backups/`. They're gitignored and harmless, and I haven't deleted them, per the "ask first" rule.
7. **Second user / sharing:** not now, per CLAUDE.md. The data layer stays isolated in `db.js`.

## 8. Small issues noticed while writing this (code)

All three are now fixed.
- **The rule note in the import preview** always said "contains", whatever the rule's type. It now names the real type, using the same wording as the Payees screen.
- **`public/styles.css`** had two `.app-header` rules one after the other. They're now one.
- **`CLAUDE.md`** had an empty bullet in "Code style". You removed it.

## 9. Working agreements from chat (not in CLAUDE.md)

- **Commits:**
  - Work goes on `main`. `.claude/settings.json` is committed, at your request.
  - You approve each commit by saying "commit".
  - A larger milestone is split into lettered steps (5a/5b, 9.0/9a/9b), one commit each.
- **Claude's own safety habits:**
  - Before starting a server or reseeding, Claude checks whether port 3000 is in use. If you're running a server, Claude doesn't start a second one or reseed under it.
  - Claude stops only the server it started, by its process id, never every node server. (This came from milestone 5a, when a reseed and a `pkill` disrupted your running server.)
  - Claude develops only with `--demo`, and tests real mode only against a throwaway database in its scratch folder.
- **Sample bank data:**
  - Sample bank rows are pasted into chat with details changed, never saved as real files in the project.
  - Your pasted rows (anonymised) are the basis of `test/csv.test.js`.
