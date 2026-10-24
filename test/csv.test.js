// Tests for CSV: writing the register export and reading bank downloads. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csvField, safeText, buildCsv, exportRegisterCsv,
  parseCsv, decodeEntities, parseBankDate, parseBankCsv,
} from '../src/csv.js';
import { centsToPlainText } from '../src/money.js';

// --- Plain amounts ---

test('cents become plain numbers with no commas or rounding', () => {
  assert.equal(centsToPlainText(0), '0.00');
  assert.equal(centsToPlainText(5), '0.05');
  assert.equal(centsToPlainText(-5), '-0.05');
  assert.equal(centsToPlainText(123456), '1234.56');
  assert.equal(centsToPlainText(-123456789), '-1234567.89');
  // 0.1 + 0.2 as decimals is 0.30000000000000004; in cents it's exactly 30.
  assert.equal(centsToPlainText(10 + 20), '0.30');
  assert.throws(() => centsToPlainText(12.5));
});

// --- Quoting ---

test('plain values are written as they are', () => {
  assert.equal(csvField('Corner Market'), 'Corner Market');
  assert.equal(csvField('-1234.56'), '-1234.56');
  assert.equal(csvField(null), '');
});

test('values with commas, quotes or line breaks are quoted', () => {
  assert.equal(csvField('Smith, Jones & Co'), '"Smith, Jones & Co"');
  assert.equal(csvField('The "good" bakery'), '"The ""good"" bakery"');
  assert.equal(csvField('line one\nline two'), '"line one\nline two"');
});

test('text that a spreadsheet would treat as a formula is made plain text', () => {
  assert.equal(safeText('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  assert.equal(safeText('+1 Mobile'), "'+1 Mobile");
  assert.equal(safeText('@home'), "'@home");
  assert.equal(safeText('Corner Market'), 'Corner Market');
});

test('a CSV file has a header marker, comma-joined fields and \\r\\n line ends', () => {
  const text = buildCsv([['a', 'b,c'], ['1', '2']]);
  assert.equal(text, '\uFEFFa,"b,c"\r\n1,2\r\n');
});

// --- Register export ---

// A small fake register, shaped like db.getRegister rows.
const row = (date, amount_cents, extra = {}) => ({
  date,
  amount_cents,
  status: 'uncleared',
  check_number: null,
  payee: null,
  memo: null,
  category_group: null,
  category_name: null,
  transfer_id: null,
  transfer_account: null,
  ...extra,
});

const checking = {
  name: 'Everyday Checking',
  opening_balance_cents: 100000,
  rows: [
    row('2026-01-05', -2500, { payee: 'Corner Market', category_group: 'Food', category_name: 'Groceries', status: 'cleared' }),
    row('2026-02-10', -50000, { payee: 'Move to savings', transfer_id: 9, transfer_account: 'Rainy Day Savings' }),
    row('2026-03-01', 215000, { payee: 'Acme, Inc.', category_group: 'Michael Income', category_name: 'Pay', check_number: '1001' }),
  ],
};

// The exported lines, without the leading marker, split back into lines.
const linesOf = (csv) => csv.replace('\uFEFF', '').trimEnd().split('\r\n');

test('the export has the header and one line per transaction', () => {
  const lines = linesOf(exportRegisterCsv([checking]));
  assert.equal(lines[0], 'Date,Account,Num,Payee,Category Group,Category,Memo,Amount,Status,Balance');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '2026-01-05,Everyday Checking,,Corner Market,Food,Groceries,,-25.00,cleared,975.00');
});

test('transfers show "Transfer" and the other account instead of a category', () => {
  const lines = linesOf(exportRegisterCsv([checking]));
  assert.equal(lines[2], '2026-02-10,Everyday Checking,,Move to savings,Transfer,Rainy Day Savings,,-500.00,uncleared,475.00');
});

test('a date range leaves out rows outside it', () => {
  const lines = linesOf(exportRegisterCsv([checking], { from: '2026-02-01', to: '2026-02-28' }));
  assert.equal(lines.length, 2); // header + the February row
  assert.match(lines[1], /^2026-02-10,/);
});

test('balances in a date-limited export still count earlier transactions', () => {
  // Starting in March, the balance must include January and February.
  const lines = linesOf(exportRegisterCsv([checking], { from: '2026-03-01' }));
  assert.equal(lines[1], '2026-03-01,Everyday Checking,1001,"Acme, Inc.",Michael Income,Pay,,2150.00,uncleared,2625.00');
});

test('all-accounts export keeps each account\'s own running balance', () => {
  const savings = {
    name: 'Rainy Day Savings',
    opening_balance_cents: 0,
    rows: [row('2026-02-10', 50000, { transfer_id: 2, transfer_account: 'Everyday Checking' })],
  };
  const lines = linesOf(exportRegisterCsv([checking, savings]));
  assert.equal(lines.length, 5);
  assert.equal(lines[4], '2026-02-10,Rainy Day Savings,,,Transfer,Everyday Checking,,500.00,uncleared,500.00');
});

// --- Reading bank downloads ---
//
// Built from the owner's sample rows (details already altered). Real checking
// downloads end each data row with an extra empty column, so these do too.

const DEPOSIT_FILE = [
  'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
  'CREDIT,9/14/26,Transfer from Savings,100,ACCT_XFER,2397.55,,',
  'DEBIT,1/5/26,Wegmans,-100,DEBIT_CARD,4199.64,,',
  'CHECK,2/13/26,CHECK 259,-100,CHECK_PAID,5293.39,259,',
  'CREDIT,4/16/26,"Repayment, dinner",100,PARTNERFI_TO_CHASE,6253.71,,',
].join('\r\n');

const CARD_FILE = [
  'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  '9/18/26,9/22/26,Offer:Deal Lake Bar &amp; Co.,Fees & Adjustments,Adjustment,4.75,',
  '9/4/26,9/4/26,Payment Thank You,,Payment,500,',
  '8/28/26,8/30/26,Car Service,Automotive,Sale,-200,',
].join('\n');

// Shaped like a Fidelity activity download (made-up amounts), newest first.
// Each dividend has a matching REINVESTMENT row buying shares with it.
const FIDELITY_HEADER =
  'Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Cash Balance ($),Settlement Date';
const FIDELITY_FILE = [
  FIDELITY_HEADER,
  '10/19/2026,DIRECT DEPOSIT JPMorgan ChaExt Trnsfr (Cash),"",No Description,Cash,"",0,"","","",500,1600.50,""',
  '09/30/2026,REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash),SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,1,12.34,"","","","-12.34",1100.50,""',
  '09/30/2026,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash),SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,"",0,"","","",12.34,1100.50,""',
].join('\n');

test('parseCsv handles quoted commas, doubled quotes and line breaks inside quotes', () => {
  const rows = parseCsv('a,"b, c","say ""hi"""\r\n"two\nlines",x,y\n\nlast,1,2');
  assert.deepEqual(rows.map((r) => r.fields), [
    ['a', 'b, c', 'say "hi"'],
    ['two\nlines', 'x', 'y'],
    ['last', '1', '2'],
  ]);
  // Line numbers count the line break inside quotes and skip the blank line.
  assert.deepEqual(rows.map((r) => r.line), [1, 2, 5]);
});

test('bank dates M/D/YY become YYYY-MM-DD; impossible dates are refused', () => {
  assert.equal(parseBankDate('9/14/26'), '2026-09-14');
  assert.equal(parseBankDate('01/05/2026'), '2026-01-05');
  assert.equal(parseBankDate('2/29/28'), '2028-02-29');
  assert.equal(parseBankDate('2/30/26'), null);
  assert.equal(parseBankDate('13/1/26'), null);
  assert.equal(parseBankDate('2026-01-05'), null);
});

test('web-page codes in descriptions are turned back into characters', () => {
  assert.equal(decodeEntities('Deal Lake Bar &amp; Co.'), 'Deal Lake Bar & Co.');
  assert.equal(decodeEntities('Joe&#39;s'), "Joe's");
  assert.equal(decodeEntities('AT&T'), 'AT&T');
});

test('a checking download is recognised and read', () => {
  const { format, rows, problems } = parseBankCsv(DEPOSIT_FILE, 'checking');
  assert.equal(format.id, 'chase-deposit');
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 4);

  const [transfer, wegmans, check, repayment] = rows;
  assert.equal(transfer.date, '2026-09-14');
  assert.equal(transfer.amountCents, 10000);
  assert.equal(transfer.bankType, 'ACCT_XFER');
  assert.equal(transfer.bankBalanceCents, 239755);
  assert.equal(wegmans.amountCents, -10000);
  assert.equal(check.checkNumber, '259');
  assert.equal(wegmans.checkNumber, null);
  assert.equal(repayment.description, 'Repayment, dinner');
});

test('a tab-separated copy of the same file reads the same way', () => {
  const tabbed = DEPOSIT_FILE.replaceAll(',', '\t').replace('"Repayment\t dinner"', 'Repayment dinner');
  const { rows } = parseBankCsv(tabbed, 'savings');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].bankBalanceCents, 239755);
});

test('a credit card download is recognised and read', () => {
  const { format, rows } = parseBankCsv(CARD_FILE, 'credit_card');
  assert.equal(format.id, 'chase-card');
  const [offer, payment, service] = rows;
  assert.equal(offer.description, 'Offer:Deal Lake Bar & Co.');
  assert.equal(offer.date, '2026-09-18'); // the transaction date, not the post date
  assert.equal(offer.amountCents, 475);
  assert.equal(payment.amountCents, 50000);
  assert.equal(service.amountCents, -20000);
  assert.equal(service.bankCategory, 'Automotive');
  assert.equal(service.bankBalanceCents, null);
});

test('a Fidelity download is read, leaving out the reinvestment rows', () => {
  const { format, rows, skipped } = parseBankCsv(FIDELITY_FILE, 'investment');
  assert.equal(format.id, 'fidelity');
  // The reinvestment only buys shares with the dividend; the cash is unchanged.
  assert.equal(skipped, 1);
  const [deposit, dividend] = rows;
  assert.equal(rows.length, 2);
  assert.equal(deposit.date, '2026-10-19');
  assert.equal(deposit.description, 'DIRECT DEPOSIT JPMorgan ChaExt Trnsfr (Cash)');
  assert.equal(deposit.amountCents, 50000);
  assert.equal(deposit.bankBalanceCents, 160050);
  assert.equal(dividend.description, 'DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)');
  assert.equal(dividend.amountCents, 1234);
  assert.equal(dividend.checkNumber, null);
});

test('Fidelity fingerprints are the same across overlapping downloads', () => {
  const first = parseBankCsv(FIDELITY_FILE, 'investment').rows;
  const later = [
    FIDELITY_HEADER,
    '10/31/2026,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash),SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,"",0,"","","",3.10,1603.60,""',
    ...FIDELITY_FILE.split('\n').slice(1),
  ].join('\n');
  const again = parseBankCsv(later, 'investment').rows;
  assert.deepEqual(again.slice(1).map((r) => r.fingerprint), first.map((r) => r.fingerprint));
});

test('the Chase formats skip nothing', () => {
  assert.equal(parseBankCsv(DEPOSIT_FILE, 'checking').skipped, 0);
});

test('the wrong kind of file for the account is refused', () => {
  assert.throws(() => parseBankCsv(FIDELITY_FILE, 'checking'), /Fidelity download/);
  assert.throws(() => parseBankCsv(CARD_FILE, 'checking'), /credit card download/);
  assert.throws(() => parseBankCsv(DEPOSIT_FILE, 'credit_card'), /checking\/savings download/);
  assert.throws(() => parseBankCsv(DEPOSIT_FILE, 'investment'), /doesn't fit/);
  assert.throws(() => parseBankCsv('Date,Amount\n1/1/26,5', 'checking'), /aren't a format/);
  assert.throws(() => parseBankCsv('', 'checking'), /empty/);
});

test('rows that cannot be read are reported by line, and the rest still load', () => {
  const file = `${DEPOSIT_FILE}\r\nDEBIT,13/45/26,Bad date,-5,DEBIT_CARD,1,,\r\nDEBIT,1/6/26,Bad amount,abc,DEBIT_CARD,1,,`;
  const { rows, problems } = parseBankCsv(file, 'checking');
  assert.equal(rows.length, 4);
  assert.deepEqual(problems, ['line 6: "13/45/26" is not a date', 'line 7: "abc" is not an amount']);
});

test('fingerprints are the same across downloads but keep identical rows apart', () => {
  const coffee = '2/3/26,2/3/26,Bean There Coffee,Food & Drink,Sale,-5.75,';
  const header = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo';
  const first = parseBankCsv([header, coffee, coffee].join('\n'), 'credit_card').rows;
  const again = parseBankCsv([header, coffee, coffee, '2/4/26,2/4/26,Other,,Sale,-1,'].join('\n'), 'credit_card').rows;

  // Two identical coffees on one day are two different rows...
  assert.notEqual(first[0].fingerprint, first[1].fingerprint);
  // ...and a later, overlapping download produces the same two fingerprints.
  assert.equal(again[0].fingerprint, first[0].fingerprint);
  assert.equal(again[1].fingerprint, first[1].fingerprint);
});
