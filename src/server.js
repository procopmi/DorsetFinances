// The web server. It does two jobs:
//   1. Serves the files in public/ (the HTML, CSS and JavaScript the browser runs).
//   2. Answers small JSON "API" requests under /api/ by calling functions in db.js.
//
// It uses Node's built-in http module rather than a framework like Express. We
// only need a handful of routes, and this keeps the app at zero npm packages.

import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { dbPath, isSampleData, HOST, PORT, publicDir } from './config.js';
import * as db from './db.js';
import { runningBalances, clearedBalance } from './money.js';
import { exportRegisterCsv, parseBankCsv } from './csv.js';
import { makeBackup } from './backup.js';
import { matchRule, suggestPattern } from './rules.js';

// --- Input checks ---
//
// The browser checks input too, but the server checks again: it is the last
// stop before the database, so it must never trust what it's sent.

const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'investment'];

// An Error carrying an HTTP status code. 400 means "your request was wrong";
// 404 means "no such thing". Anything without a status is reported as 500,
// meaning "the server itself hit a problem".
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function requireId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw httpError(400, 'Invalid id');
  return value;
}

function requireName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw httpError(400, 'A name is required');
  return value.trim();
}

// Money must arrive as whole cents. A decimal here means a bug somewhere.
function requireCents(value) {
  if (!Number.isSafeInteger(value)) throw httpError(400, 'Amount must be whole cents');
  return value;
}

// 'YYYY-MM-DD', and a real calendar date (rejects 2026-02-30 and 2026-13-01).
function requireDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  const isRealDate =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    // An impossible month gives an "invalid date" (NaN); check before using it.
    !Number.isNaN(parsed.getTime()) &&
    // An impossible day like Feb 30 rolls over to Mar 2, so compare back.
    parsed.toISOString().slice(0, 10) === value;
  if (!isRealDate) throw httpError(400, `"${value}" is not a valid date`);
  return value;
}

// Optional text such as a memo: blank becomes null (nothing stored), and very
// long values are refused rather than silently cut short.
function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw httpError(400, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw httpError(400, `${label} is too long (max ${maxLength})`);
  return trimmed === '' ? null : trimmed;
}

// A category id, or null for "uncategorized". Only sub-categories can be
// assigned; groups (like "Utilities") exist to total up their subs.
// Hidden categories are allowed, so an older transaction that uses one can
// still be edited and saved; hiding only removes it from the suggestions.
function optionalCategoryId(value) {
  if (value === undefined || value === null) return null;
  const category = db.getCategory(requireId(value));
  if (!category) throw httpError(400, 'No such category');
  if (category.parent_id === null) {
    throw httpError(400, `"${category.name}" is a group; choose one of its sub-categories`);
  }
  return category.id;
}

const CATEGORY_KINDS = ['income', 'expense'];
const TRANSACTION_STATUSES = ['uncleared', 'cleared', 'reconciled'];

// Look-ups that also check the thing exists, so each route can stay short.

function requireCategory(id) {
  const category = db.getCategory(requireId(id));
  if (!category) throw httpError(404, 'No such category');
  return category;
}

// A top-level group (not a sub), e.g. as the target of a move.
function requireGroup(id) {
  const category = requireCategory(id);
  if (category.parent_id !== null) throw httpError(400, `"${category.name}" is not a group`);
  return category;
}

function requirePayee(id) {
  const payee = db.getPayee(requireId(id));
  if (!payee) throw httpError(404, 'No such payee');
  return payee;
}

function requireCategoryNameFree(name, parentId, exceptId) {
  if (db.categoryNameTaken(name, parentId, exceptId)) {
    throw httpError(400, `There is already a category named "${name}" ${parentId === null ? 'among the groups' : 'in that group'}`);
  }
}

// The other account of a transfer, or null for an ordinary transaction.
// It must be a different account, and open, unless it's the account the
// transfer already goes to (so a transfer to an account closed later can
// still be edited).
function optionalTransferAccountId(value, ownAccountId, currentOtherAccountId = null) {
  if (value === undefined || value === null) return null;
  const account = db.getAccount(requireId(value));
  if (!account) throw httpError(400, 'No such account to transfer to');
  if (account.id === ownAccountId) throw httpError(400, 'A transfer needs two different accounts');
  if (account.is_closed && account.id !== currentOtherAccountId) {
    throw httpError(400, `"${account.name}" is closed; reopen it to transfer to it`);
  }
  return account.id;
}

// The register fields shared by "add" and "edit". The category box holds
// either a category or "Transfer: <account>", never both.
function readTransactionFields(body, ownAccountId, currentOtherAccountId) {
  if (body.categoryId != null && body.transferAccountId != null) {
    throw httpError(400, 'A transfer has no category; choose one or the other');
  }
  return {
    date: requireDate(body.date),
    checkNumber: optionalText(body.checkNumber, 'Check number', 20),
    payeeName: optionalText(body.payee, 'Payee', 100),
    categoryId: optionalCategoryId(body.categoryId),
    transferAccountId: optionalTransferAccountId(body.transferAccountId, ownAccountId, currentOtherAccountId),
    memo: optionalText(body.memo, 'Memo', 200),
    amountCents: requireCents(body.amountCents),
  };
}

// Bank row types that usually mean money moving between your own accounts.
// Used only to add a hint in the preview.
function looksLikeTransfer(formatId, bankType) {
  if (formatId === 'chase-card') return bankType === 'Payment';
  return bankType === 'ACCT_XFER' || bankType === 'LOAN_PMT';
}

// The bank's own balance after its most recent row, from a checking/savings
// file: { date, cents }, or null if the file has no balances (card files).
// For several rows on the latest date, the first one in the file is taken,
// since the bank lists newest first.
function latestBankBalance(rows) {
  let latest = null;
  for (const row of rows) {
    if (row.bankBalanceCents === null) continue;
    if (!latest || row.date > latest.date) latest = { date: row.date, cents: row.bankBalanceCents };
  }
  return latest;
}

// The account and the parsed bank file for an import request.
function readImportFile(body) {
  const account = db.getAccount(requireId(body.accountId));
  if (!account) throw httpError(404, 'No such account');
  if (account.is_closed) throw httpError(400, 'This account is closed; reopen it to import into it');
  if (typeof body.fileText !== 'string') throw httpError(400, 'No file was sent');

  try {
    return { account, parsed: parseBankCsv(body.fileText, account.type) };
  } catch (err) {
    // Problems with the file itself (unknown format, wrong account type) are
    // the user's to fix, not a server fault.
    throw httpError(400, err.message);
  }
}

function requireTransaction(id) {
  const transaction = db.getTransaction(requireId(id));
  if (!transaction) throw httpError(404, 'No such transaction');
  return transaction;
}

// --- API routes ---
//
// Each "METHOD /path" maps to a function that receives the request's input:
// for POST, the parsed JSON body; for GET, the "?name=value" query parameters
// (which always arrive as text). Whatever it returns is sent back as JSON.
// Ids travel in the input (not the URL path) so this table stays a simple lookup.

const apiRoutes = {
  'GET /api/info': () => ({ isSampleData }),

  'GET /api/accounts': () => db.listAccounts(),

  // One account's register: its transactions in order, each with the running
  // balance after it. The balance is calculated here, fresh, on every request.
  'GET /api/register': (query) => {
    // Query values are text ("3"), so convert to a number before checking.
    const accountId = requireId(Number(query.accountId));
    const account = db.getAccount(accountId);
    if (!account) throw httpError(404, 'No such account');

    const rows = db.getRegister(accountId);
    const balances = runningBalances(
      account.opening_balance_cents,
      rows.map((row) => row.amount_cents)
    );

    return {
      openingBalanceCents: account.opening_balance_cents,
      openingDate: account.opening_date,
      // What the bank should show; compare it with your online balance.
      clearedBalanceCents: clearedBalance(account.opening_balance_cents, rows),
      rows: rows.map((row, i) => ({ ...row, balance_cents: balances[i] })),
    };
  },

  // Downloads a CSV of one account (?accountId=3) or all accounts
  // (?accountId=all), optionally limited to ?from=YYYY-MM-DD and/or ?to=...
  'GET /api/export': (query) => {
    const from = query.from ? requireDate(query.from) : null;
    const to = query.to ? requireDate(query.to) : null;
    if (from && to && from > to) throw httpError(400, 'The From date is after the To date');

    let accounts;
    let label;
    if (query.accountId === 'all') {
      accounts = db.listAccounts();
      label = 'All-accounts';
    } else {
      const account = db.getAccount(requireId(Number(query.accountId)));
      if (!account) throw httpError(404, 'No such account');
      accounts = [account];
      // Keep only letters and digits in the file name, so any account name is safe.
      label = account.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Account';
    }

    const csv = exportRegisterCsv(
      accounts.map((a) => ({ ...a, rows: db.getRegister(a.id) })),
      { from, to }
    );
    return new FileDownload(`${label}-${todayText()}.csv`, 'text/csv; charset=utf-8', csv);
  },

  // --- Importing bank downloads ---
  //
  // Two steps. "preview" reads the file and says what would happen, changing
  // nothing. "commit" reads the same file again, applies your choices from the
  // preview, makes a backup, and adds the rows. Re-reading the file (rather
  // than trusting rows sent back by the page) means dates and amounts always
  // come straight from the bank's file.

  // For each row the preview suggests, in this order:
  //   - a payee: from a remembered rule, else a payee named like the bank
  //     text, else the bank text itself (plus that payee's usual category);
  //   - a hand-entered row it's the bank's copy of (use that instead), or
  //   - the other half of a transfer already in another account (link it).
  'POST /api/import/preview': (body) => {
    const { account, parsed } = readImportFile(body);
    const alreadyImported = db.importedFingerprints(account.id);
    const rules = db.listPayeeRules();
    // Each existing row can be matched to only one row of the file, so two
    // identical bank rows don't both claim the same hand-entered row.
    const claimed = new Set();

    const rows = parsed.rows.map((row) => {
      const result = {
        ...row,
        isDuplicate: alreadyImported.has(row.fingerprint),
        suggestedPattern: suggestPattern(row.description),
        suggestedPayee: row.description,
        suggestedCategoryId: null,
        rule: null,
        handEntered: null,
        transferMatch: null,
        otherTransferMatches: 0,
        looksLikeTransfer: looksLikeTransfer(parsed.format.id, row.bankType),
      };
      if (result.isDuplicate) return result;

      const rule = matchRule(row.description, rules);
      const payee = rule
        ? { name: rule.payee_name, default_category_id: rule.default_category_id }
        : db.findPayeeByName(row.description);
      if (payee) {
        result.suggestedPayee = payee.name;
        result.suggestedCategoryId = payee.default_category_id;
      }
      if (rule) result.rule = { matchType: rule.match_type, pattern: rule.pattern };

      const where = { accountId: account.id, amountCents: row.amountCents, date: row.date };
      const handEntered = db
        .findHandEnteredMatches({ ...where, checkNumber: row.checkNumber })
        .find((m) => !claimed.has(m.id));
      if (handEntered) {
        claimed.add(handEntered.id);
        result.handEntered = handEntered;
        return result;
      }

      const candidates = db.findTransferCandidatesFor(where).filter((c) => !claimed.has(c.id));
      // Only suggest a link when there's exactly one candidate; with several,
      // choosing is left to "Link…" in the register.
      if (candidates.length === 1) {
        claimed.add(candidates[0].id);
        result.transferMatch = candidates[0];
      } else {
        result.otherTransferMatches = candidates.length;
      }
      return result;
    });

    return {
      format: parsed.format,
      problems: parsed.problems,
      rows,
      bankBalance: latestBankBalance(parsed.rows),
    };
  },

  // choices: one per row you kept ticked:
  //   { fingerprint, payee, categoryId, handEnteredId?, linkToId?, rememberPattern? }
  'POST /api/import/commit': (body) => {
    const { account, parsed } = readImportFile(body);
    if (!Array.isArray(body.choices)) throw httpError(400, 'No rows chosen');

    const byFingerprint = new Map(parsed.rows.map((row) => [row.fingerprint, row]));
    const alreadyImported = db.importedFingerprints(account.id);
    const used = new Set(); // existing rows already matched or linked by this import
    const changed = () =>
      httpError(400, 'Something changed since the preview. Please start the import again.');
    const toImport = [];
    let skipped = 0;

    for (const choice of body.choices) {
      const row = byFingerprint.get(choice.fingerprint);
      if (!row) throw httpError(400, 'The file no longer matches the preview. Please start the import again.');
      // Checked again here, so importing twice (a double click, or the same
      // file in two tabs) can't add the rows twice.
      if (alreadyImported.has(row.fingerprint)) {
        skipped++;
        continue;
      }
      alreadyImported.add(row.fingerprint);

      const item = {
        date: row.date,
        amountCents: row.amountCents,
        payeeName: optionalText(choice.payee, 'Payee', 100),
        categoryId: optionalCategoryId(choice.categoryId),
        memo: row.memo,
        checkNumber: row.checkNumber,
        bankDescription: row.description,
        fingerprint: row.fingerprint,
      };

      // Each match is checked again, in case the register changed since the preview.
      if (choice.handEnteredId != null) {
        const existing = db.getTransaction(requireId(choice.handEnteredId));
        const stillMatches =
          existing &&
          existing.account_id === account.id &&
          existing.amount_cents === row.amountCents &&
          existing.status === 'uncleared' &&
          !used.has(existing.id);
        if (!stillMatches) throw changed();
        used.add(existing.id);
        item.handEnteredId = existing.id;
      } else if (choice.linkToId != null) {
        const other = db.getTransaction(requireId(choice.linkToId));
        const stillMatches =
          other &&
          other.account_id !== account.id &&
          other.amount_cents === -row.amountCents &&
          other.transfer_id === null &&
          !used.has(other.id);
        if (!stillMatches) throw changed();
        used.add(other.id);
        item.linkToId = other.id;
      }

      if (choice.rememberPattern != null) {
        const pattern = optionalText(choice.rememberPattern, 'Rule pattern', 100);
        if (!pattern) throw httpError(400, `${row.date} ${row.description}: the rule needs some text to look for`);
        if (!item.payeeName) throw httpError(400, `${row.date} ${row.description}: a rule needs a payee`);
        item.rule = { pattern };
      }
      toImport.push(item);
    }

    // Back up before changing anything (project rule: back up before an import).
    const backupFile = toImport.length > 0 ? makeBackup('import') : null;
    const counts = db.importTransactions(account.id, toImport);

    // For the check against the bank: your cleared balance now, next to the
    // bank's own balance from the file (checking and savings files only).
    const register = db.getRegister(account.id);
    return {
      ...counts,
      skipped,
      backupFile,
      clearedBalanceCents: clearedBalance(account.opening_balance_cents, register),
      bankBalance: latestBankBalance(parsed.rows),
    };
  },

  // --- Payee rules (listed and deleted on the Payees screen) ---

  'GET /api/payee-rules': () => db.listPayeeRules(),

  'POST /api/payee-rules/delete': (body) => {
    if (!db.deletePayeeRule(requireId(body.id))) throw httpError(404, 'No such rule');
    return { ok: true };
  },

  // Set one transaction to uncleared, cleared or reconciled.
  'POST /api/transactions/set-status': (body) => {
    if (!TRANSACTION_STATUSES.includes(body.status)) throw httpError(400, 'Unknown status');
    if (!db.setTransactionStatus(requireId(body.id), body.status)) {
      throw httpError(404, 'No such transaction');
    }
    return { ok: true };
  },

  // Marks every cleared transaction in an account as reconciled. The page
  // asks first, showing the cleared balance to compare with the bank.
  'POST /api/accounts/reconcile-cleared': (body) => {
    const accountId = requireId(body.accountId);
    if (!db.getAccount(accountId)) throw httpError(404, 'No such account');
    return { count: db.reconcileCleared(accountId) };
  },

  'GET /api/payees': () => db.listPayees(),

  'GET /api/categories': () => db.listCategories(),

  // --- Managing categories (the Categories screen) ---

  // Adds a group ({name, kind}) or a sub ({name, parentId}). A sub always
  // takes its group's kind, so only groups need one.
  'POST /api/categories': (body) => {
    const name = requireName(body.name);
    let parentId = null;
    let kind = body.kind;

    if (body.parentId !== undefined && body.parentId !== null) {
      const parent = requireGroup(body.parentId);
      parentId = parent.id;
      kind = parent.kind;
    } else if (!CATEGORY_KINDS.includes(kind)) {
      throw httpError(400, 'A group must be income or expense');
    }

    requireCategoryNameFree(name, parentId);
    return { id: db.createCategory({ name, kind, parentId }) };
  },

  'POST /api/categories/rename': (body) => {
    const category = requireCategory(body.id);
    const name = requireName(body.name);
    requireCategoryNameFree(name, category.parent_id, category.id);
    db.renameCategory(category.id, name);
    return { ok: true };
  },

  // Hiding keeps a category on old transactions but drops it from suggestions.
  'POST /api/categories/set-hidden': (body) => {
    db.setCategoryHidden(requireCategory(body.id).id, body.isHidden === true);
    return { ok: true };
  },

  'POST /api/categories/move': (body) => {
    const category = requireCategory(body.id);
    if (category.parent_id === null) throw httpError(400, 'Only sub-categories can be moved');
    const target = requireGroup(body.parentId);
    if (target.id === category.parent_id) throw httpError(400, 'It is already in that group');
    requireCategoryNameFree(category.name, target.id);
    db.moveCategory(category.id, target.id);
    return { ok: true };
  },

  // The page asks for confirmation before calling this.
  'POST /api/categories/delete': (body) => {
    const category = requireCategory(body.id);
    if (category.parent_id === null && db.countSubcategories(category.id) > 0) {
      throw httpError(400, `"${category.name}" still has sub-categories. Delete or move them first, or hide the group.`);
    }
    // Deleting a used category would leave those transactions without one,
    // so refuse; hiding is the safe way to retire it.
    const count = db.countCategoryTransactions(category.id);
    if (count > 0) {
      throw httpError(400, `"${category.name}" is used by ${count} transaction(s). Hide it instead.`);
    }
    db.deleteCategory(category.id);
    return { ok: true };
  },

  // --- Managing payees (the Payees screen) ---

  'GET /api/payees/all': () => db.listPayeesWithUsage(),

  'POST /api/payees/rename': (body) => {
    const payee = requirePayee(body.id);
    const name = requireName(body.name);
    // Two payees with one name would be confusing; joining them is what Merge is for.
    if (db.payeeNameTaken(name, payee.id)) {
      throw httpError(400, `A payee named "${name}" already exists. Use Merge to combine them.`);
    }
    db.renamePayee(payee.id, name);
    return { ok: true };
  },

  'POST /api/payees/set-hidden': (body) => {
    db.setPayeeHidden(requirePayee(body.id).id, body.isHidden === true);
    return { ok: true };
  },

  'POST /api/payees/set-default-category': (body) => {
    db.setPayeeDefaultCategory(requirePayee(body.id).id, optionalCategoryId(body.categoryId));
    return { ok: true };
  },

  // The page asks for confirmation before calling this.
  'POST /api/payees/merge': (body) => {
    const from = requirePayee(body.fromId);
    const into = requirePayee(body.intoId);
    if (from.id === into.id) throw httpError(400, 'Choose a different payee to merge into');
    return { moved: db.mergePayees(from.id, into.id) };
  },

  'POST /api/transactions': (body) => {
    const accountId = requireId(body.accountId);
    if (!db.getAccount(accountId)) throw httpError(404, 'No such account');
    const id = db.createTransaction({ accountId, ...readTransactionFields(body, accountId) });
    return { id };
  },

  'POST /api/transactions/update': (body) => {
    const existing = requireTransaction(body.id);
    const otherHalf = existing.transfer_id === null ? null : db.getTransaction(existing.transfer_id);
    const fields = readTransactionFields(body, existing.account_id, otherHalf?.account_id);
    // Making a transfer an ordinary transaction would strand its other half,
    // so that goes through Unlink, which keeps both rows on purpose.
    if (otherHalf && !fields.transferAccountId) {
      throw httpError(400, 'This is a transfer. Use Unlink first to make it an ordinary transaction.');
    }
    db.updateTransaction(existing.id, fields);
    return { ok: true };
  },

  // The page asks for confirmation before calling this. A transfer's other
  // half is deleted too.
  'POST /api/transactions/delete': (body) => {
    if (!db.deleteTransaction(requireId(body.id))) throw httpError(404, 'No such transaction');
    return { ok: true };
  },

  // --- Transfers ---

  // Rows in other accounts that could be this row's other half (opposite
  // amount, within a week), for "Link as transfer".
  'GET /api/transfers/candidates': (query) => {
    const transaction = requireTransaction(Number(query.id));
    return db.findTransferCandidates(transaction.id);
  },

  // Joins two existing rows (e.g. both sides imported from two banks) into
  // one transfer. The page asks first, since their categories are cleared.
  'POST /api/transfers/link': (body) => {
    const a = requireTransaction(body.id);
    const b = requireTransaction(body.otherId);
    if (a.account_id === b.account_id) throw httpError(400, 'A transfer needs two different accounts');
    if (a.transfer_id !== null || b.transfer_id !== null) {
      throw httpError(400, 'One of these is already part of a transfer');
    }
    // Money leaving one account must arrive in the other, to the cent.
    if (a.amount_cents !== -b.amount_cents) {
      throw httpError(400, 'The two amounts must be opposite (e.g. -500.00 and +500.00)');
    }
    db.linkTransfer(a.id, b.id);
    return { ok: true };
  },

  // Turns a transfer back into two ordinary rows; nothing is deleted.
  'POST /api/transfers/unlink': (body) => {
    if (!db.unlinkTransfer(requireTransaction(body.id).id)) {
      throw httpError(400, 'This transaction is not a transfer');
    }
    return { ok: true };
  },

  'POST /api/accounts': (body) => {
    if (!ACCOUNT_TYPES.includes(body.type)) throw httpError(400, 'Unknown account type');
    const id = db.createAccount({
      name: requireName(body.name),
      type: body.type,
      openingBalanceCents: requireCents(body.openingBalanceCents),
      openingDate: requireDate(body.openingDate),
    });
    return { id };
  },

  'POST /api/accounts/rename': (body) => {
    if (!db.renameAccount(requireId(body.id), requireName(body.name))) {
      throw httpError(404, 'No such account');
    }
    return { ok: true };
  },

  'POST /api/accounts/set-closed': (body) => {
    if (!db.setAccountClosed(requireId(body.id), body.isClosed === true)) {
      throw httpError(404, 'No such account');
    }
    return { ok: true };
  },

  'POST /api/accounts/delete': (body) => {
    const id = requireId(body.id);
    // Deleting an account with history would destroy that history, so refuse
    // and point to closing instead, which hides it but keeps everything.
    const count = db.countTransactions(id);
    if (count > 0) {
      throw httpError(400, `This account has ${count} transaction(s). Close it instead of deleting it.`);
    }
    if (!db.deleteAccount(id)) throw httpError(404, 'No such account');
    return { ok: true };
  },
};

// --- Request plumbing ---

// A route returns one of these (instead of plain data) to send a file the
// browser saves, rather than JSON.
class FileDownload {
  constructor(filename, contentType, body) {
    this.filename = filename;
    this.contentType = contentType;
    this.body = body;
  }
}

// Today as 'YYYY-MM-DD' in this Mac's time zone, for file names.
function todayText() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The browser decides how to treat a file based on this header, so each file
// type we serve needs its matching value.
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Files outside public/ that the browser is allowed to load. money.js is
// shared so the page parses and formats amounts with exactly the same (tested)
// code as the server. Listing files one by one keeps the rest of src/ private.
const sharedFiles = {
  '/money.js': fileURLToPath(new URL('./money.js', import.meta.url)),
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Bank downloads arrive inside the request, so allow a generous size, but
// not unlimited (a years-long download is well under 5 million characters).
const MAX_BODY_CHARACTERS = 10_000_000;

async function readJsonBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY_CHARACTERS) throw httpError(413, 'That file is too large to import');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, 'Request body is not valid JSON');
  }
  // Every route expects an object like {"id": 3}, so reject anything else
  // (such as a bare number or null) up front.
  if (typeof body !== 'object' || body === null) throw httpError(400, 'Request body must be a JSON object');
  return body;
}

async function serveStaticFile(res, urlPath) {
  let filePath = sharedFiles[urlPath];

  if (!filePath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    filePath = path.join(publicDir, relative);

    // Refuse paths like "/../src/config.js" that try to climb out of public/.
    // Only files inside public/ (plus sharedFiles) are ever sent to the browser.
    if (!filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(404).end('Not found');
      return;
    }
  }

  try {
    const body = await readFile(filePath);
    const type = contentTypes[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// Two guards against other websites open in your browser reaching this server.
// Even though the server only listens on this Mac, any web page you visit can
// try to send requests to 127.0.0.1.
function isTrustedRequest(req) {
  // 1. The Host header must be our own address. This blocks a trick called
  //    "DNS rebinding", where a hostile site's domain is pointed at 127.0.0.1.
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return false;

  // 2. Changes (POST) must be sent as JSON. Browsers won't let another site
  //    send a JSON POST to us without first asking permission, and this server
  //    never grants it, so only our own page can make changes.
  if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
    return false;
  }
  return true;
}

async function handleRequest(req, res) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  // req.url includes any "?query" part; we route on the path alone.
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  const handler = apiRoutes[`${req.method} ${pathname}`];

  if (handler) {
    try {
      const input =
        req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(searchParams);
      const result = handler(input);
      if (result instanceof FileDownload) {
        // "attachment" tells the browser to save the file, not display it.
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        });
        res.end(result.body);
      } else {
        sendJson(res, 200, result);
      }
    } catch (err) {
      // Expected problems (bad input, missing account) carry a status and just
      // send their message. Anything else is a bug: log it in the terminal.
      if (!err.status) console.error(err);
      sendJson(res, err.status ?? 500, { error: err.message });
    }
  } else if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: `No API route for ${req.method} ${pathname}` });
  } else if (req.method === 'GET') {
    await serveStaticFile(res, pathname);
  } else {
    res.writeHead(405).end('Method not allowed');
  }
}

// --- Start up ---

// The sample-data folder holds a generated file that git ignores, so it may
// not exist yet on a fresh checkout. Create it before SQLite tries to write there.
mkdirSync(path.dirname(dbPath), { recursive: true });
db.openDb(dbPath);

http.createServer(handleRequest).listen(PORT, HOST, () => {
  console.log(`Database: ${dbPath}${isSampleData ? '  (SAMPLE DATA)' : ''}`);
  console.log(`Open http://${HOST}:${PORT} in your browser. Press Ctrl+C to stop.`);
});
