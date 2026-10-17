// Writing (and, from milestone 9, reading) CSV files.
//
// CSV ("comma-separated values") is the plain-text table format spreadsheets
// and banks use. Everything here is a plain function with no database or
// server code, so the tests can check it directly.

import { centsToPlainText, runningBalances } from './money.js';

// --- Writing ---

// One value as a CSV field. A field containing a comma, quote or line break
// is wrapped in double quotes, with any quote inside doubled ("" means ").
// That's the standard rule every spreadsheet understands.
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Text that came from people or banks (payees, memos, category names).
// A spreadsheet treats a cell starting with = + - or @ as a formula and may
// run it, so a payee like "=HYPERLINK(...)" from a bank file could do
// something unexpected when you open the export. A leading ' makes the
// spreadsheet show it as plain text. Amounts are not passed through this:
// they should stay real numbers, minus signs included.
export function safeText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

// Rows (arrays of values) to CSV text. Lines end with \r\n, the CSV standard.
// The file starts with an invisible UTF-8 marker (the "BOM") so Excel on a
// Mac reads accented letters and curly apostrophes correctly.
export function buildCsv(rows) {
  const lines = rows.map((row) => row.map(csvField).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// --- Register export ---

export const EXPORT_HEADER = [
  'Date', 'Account', 'Num', 'Payee', 'Category Group', 'Category', 'Memo', 'Amount', 'Status', 'Balance',
];

// Builds the export file for one or more accounts. Each entry in `accounts`
// is { name, opening_balance_cents, rows } where rows is that account's whole
// register (as db.getRegister returns it, oldest first).
//
// `from`/`to` ('YYYY-MM-DD', or null for no limit) choose which rows appear.
// Balances are always worked out over the full history first, so a row's
// Balance matches the register even when the export starts part-way through.
export function exportRegisterCsv(accounts, { from = null, to = null } = {}) {
  const lines = [EXPORT_HEADER];

  for (const account of accounts) {
    const balances = runningBalances(
      account.opening_balance_cents,
      account.rows.map((r) => r.amount_cents)
    );

    account.rows.forEach((r, i) => {
      // Dates are 'YYYY-MM-DD' text, which compares correctly as plain text.
      if ((from && r.date < from) || (to && r.date > to)) return;

      // A transfer has no category; show where the money went instead.
      const group = r.transfer_id ? 'Transfer' : r.category_group;
      const category = r.transfer_id ? r.transfer_account : r.category_name;

      lines.push([
        r.date,
        safeText(account.name),
        safeText(r.check_number),
        safeText(r.payee),
        safeText(group),
        safeText(category),
        safeText(r.memo),
        centsToPlainText(r.amount_cents),
        r.status,
        centsToPlainText(balances[i]),
      ]);
    });
  }

  return buildCsv(lines);
}
