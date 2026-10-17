// Writing and reading CSV files: the register export, and bank downloads.
//
// CSV ("comma-separated values") is the plain-text table format spreadsheets
// and banks use. Everything here is a plain function with no database or
// server code, so the tests can check it directly.

import { centsToPlainText, runningBalances, parseDollarsToCents } from './money.js';

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
  return `\uFEFF${lines.join('\r\n')}\r\n`;
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

// --- Reading ---

// Splits CSV text into rows of fields. Handles the standard rules: fields in
// double quotes may contain commas, line breaks and doubled quotes ("").
// `delimiter` is ',' for CSV or '\t' for tab-separated files.
// Blank lines are skipped. Each row remembers its line number (from 1), so
// problems can be reported as "line 7".
export function parseCsv(text, delimiter = ',') {
  // Drop the invisible UTF-8 marker some programs put at the start.
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let fields = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A blank line is a single empty field: skip it.
    if (!(fields.length === 1 && fields[0].trim() === '')) {
      rows.push({ line: rowLine, fields });
    }
    fields = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'; // "" inside quotes is one literal quote
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        if (char === '\n') line++;
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n' || char === '\r') {
      // Treat \r\n (Windows) and \n (Mac) the same.
      if (char === '\r' && input[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += char;
    }
  }
  // The last line may not end with a line break.
  if (field !== '' || fields.length > 0) endRow();
  return rows;
}

// Bank descriptions sometimes contain web-page codes like "&amp;" (for "&").
// Turns the common ones back into the characters they stand for.
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#\d+|[a-z]+);/gi, (whole, code) => {
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return named[code.toLowerCase()] ?? whole;
  });
}

// A bank date like "9/14/26" or "09/14/2026" (month/day/year) as our
// 'YYYY-MM-DD'. Two-digit years are taken as 20xx. Returns null if the text
// isn't a real calendar date.
export function parseBankDate(text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, month, day, yearText] = match;
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // Reject impossible dates such as 2/30/26 (they'd roll over to March).
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

// The bank download formats the app understands, recognised by their header
// line. All accounts are at Chase, so there are two: one for checking and
// savings, one for credit cards. Both already use our sign convention
// (negative = money out), so amounts are taken as they are.
//
// `read` turns one row (a lookup from column name to text) into the parts
// we use. `fingerprintParts` are the values that identify a row, used to
// recognise it if the same row turns up again in a later download.
export const BANK_FORMATS = [
  {
    id: 'chase-deposit',
    label: 'Chase checking/savings download',
    accountTypes: ['checking', 'savings'],
    header: ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'],
    read: (col) => ({
      dateText: col('Posting Date'),
      description: col('Description'),
      amountText: col('Amount'),
      checkNumber: col('Check or Slip #'),
      bankType: col('Type'),
      bankCategory: '',
      memo: '',
      bankBalanceText: col('Balance'),
      // The bank's running balance changes with every row, so it makes the
      // fingerprint unique even for two identical payments on one day.
      fingerprintParts: [col('Posting Date'), col('Description'), col('Amount'), col('Balance')],
    }),
  },
  {
    id: 'chase-card',
    label: 'Chase credit card download',
    accountTypes: ['credit_card'],
    header: ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'],
    read: (col) => ({
      // The day you made the purchase (decision 2026-10-16), not the post date.
      dateText: col('Transaction Date'),
      description: col('Description'),
      amountText: col('Amount'),
      checkNumber: '',
      bankType: col('Type'),
      // The bank's own category, shown only as a hint in the preview.
      bankCategory: col('Category'),
      memo: col('Memo'),
      bankBalanceText: '',
      fingerprintParts: [col('Transaction Date'), col('Post Date'), col('Description'), col('Amount')],
    }),
  },
];

// Header cells, tidied for comparison: trimmed, lower-case, with empty cells
// at the end dropped (some downloads add an extra empty column).
function normalizeHeader(fields) {
  const cells = fields.map((f) => f.trim().toLowerCase());
  while (cells.length > 0 && cells.at(-1) === '') cells.pop();
  return cells;
}

// The file's separator: a tab if the first line has tabs and no commas
// (as when copied out of a spreadsheet), otherwise a comma.
function detectDelimiter(text) {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  return firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
}

// Reads a bank download for an account of type `accountType`.
// Returns { format, rows, problems } where each row is
//   { line, date, description, amountCents, checkNumber, bankType,
//     bankCategory, memo, bankBalanceCents, fingerprint }
// and problems lists rows that couldn't be read ("line 7: ..."). Throws an
// Error if the file isn't a recognised format, or is the wrong kind for the
// account (a card file for a checking account).
export function parseBankCsv(text, accountType) {
  const [headerRow, ...dataRows] = parseCsv(text, detectDelimiter(text));
  if (!headerRow) throw new Error('The file is empty.');

  const header = normalizeHeader(headerRow.fields);
  const format = BANK_FORMATS.find(
    (f) => f.header.length === header.length && f.header.every((h, i) => h.toLowerCase() === header[i])
  );
  if (!format) {
    throw new Error(
      `This file's columns aren't a format the app knows. It expects a ${BANK_FORMATS.map((f) => f.label).join(' or a ')}.`
    );
  }
  if (!format.accountTypes.includes(accountType)) {
    throw new Error(`This is a ${format.label}, which doesn't fit this kind of account.`);
  }

  const rows = [];
  const problems = [];
  // How many times each fingerprint has been seen so far in this file, so
  // that genuinely identical rows (two $5 coffees on one day) stay distinct.
  const seen = new Map();

  for (const { line, fields } of dataRows) {
    // Look up a column by name; a missing trailing column counts as empty.
    const col = (name) => (fields[format.header.indexOf(name)] ?? '').trim();
    const raw = format.read(col);

    const date = parseBankDate(raw.dateText);
    if (!date) {
      problems.push(`line ${line}: "${raw.dateText}" is not a date`);
      continue;
    }
    let amountCents;
    try {
      amountCents = parseDollarsToCents(raw.amountText);
    } catch {
      problems.push(`line ${line}: "${raw.amountText}" is not an amount`);
      continue;
    }
    let bankBalanceCents = null;
    try {
      if (raw.bankBalanceText) bankBalanceCents = parseDollarsToCents(raw.bankBalanceText);
    } catch {
      // The balance is only used as a cross-check, so a bad one isn't fatal.
    }

    const base = [format.id, ...raw.fingerprintParts].join('|');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    rows.push({
      line,
      date,
      description: decodeEntities(raw.description),
      amountCents,
      checkNumber: raw.checkNumber || null,
      bankType: raw.bankType,
      bankCategory: decodeEntities(raw.bankCategory),
      memo: decodeEntities(raw.memo) || null,
      bankBalanceCents,
      // Stored as transactions.import_hash. It's readable text (not a
      // scrambled hash) so you can see in the database what it was made from.
      fingerprint: `${base}#${count}`,
    });
  }

  return { format: { id: format.id, label: format.label }, rows, problems };
}
