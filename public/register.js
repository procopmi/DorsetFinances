// Runs in the browser. It asks the server for data (fetch) and fills in the page.
// The browser never touches the database directly; it only talks to /api/ routes.

// The same money.js the server uses (and the tests cover), served at /money.js.
import { parseDollarsToCents, formatCents } from '/money.js';

// --- Page state ---
// The accounts as last loaded from the server, and which one is selected.
// After any change we reload from the server rather than patching this list by
// hand, so the page always shows exactly what's in the database.
let accounts = [];
let selectedId = null;

const byId = (id) => document.getElementById(id);

// --- Talking to the server ---

// Send a request and turn server errors (like "A name is required") into
// thrown Errors, so problems surface instead of failing silently.
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed: ${url}`);
  }
  return data;
}

const getJson = (url) => request(url);

const postJson = (url, body) =>
  request(url, {
    method: 'POST',
    // The server only accepts changes sent as JSON (see isTrustedRequest).
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Event handlers can't usefully return errors, so wrap them: any failure is
// shown to you instead of disappearing into the browser console.
function runAction(action) {
  action().catch((err) => {
    console.error(err);
    alert(err.message);
  });
}

// --- Drawing the page ---

async function reloadAccounts() {
  accounts = await getJson('/api/accounts');
  // If the selected account vanished (deleted) or nothing is selected yet,
  // fall back to the first open account.
  if (!accounts.some((a) => a.id === selectedId)) {
    selectedId = accounts.find((a) => !a.is_closed)?.id ?? null;
  }
  render();
}

function render() {
  const open = accounts.filter((a) => !a.is_closed);
  const closed = accounts.filter((a) => a.is_closed);

  fillAccountList(byId('account-list'), open);
  fillAccountList(byId('closed-account-list'), closed);
  byId('no-accounts').hidden = open.length > 0;
  byId('closed-accounts').hidden = closed.length === 0;

  renderRegisterHeader();
  runAction(loadRegister);
}

function fillAccountList(list, items) {
  const rows = items.map((account) => {
    // A <button> (rather than a plain list item) so accounts can be reached
    // with Tab and chosen with Enter, not only clicked.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-button';
    button.classList.toggle('selected', account.id === selectedId);
    // textContent (not innerHTML) so a name is always plain text, never HTML.
    button.textContent = account.name;
    button.addEventListener('click', () => {
      selectedId = account.id;
      // Leaving an account abandons any edit in progress there.
      editingId = null;
      focusedRowId = null;
      render();
    });

    const item = document.createElement('li');
    item.append(button);
    return item;
  });
  list.replaceChildren(...rows);
}

function renderRegisterHeader() {
  const account = accounts.find((a) => a.id === selectedId);
  byId('account-actions').hidden = !account;
  byId('register-title').textContent = account ? account.name : 'Register';

  if (account) {
    byId('toggle-closed').textContent = account.is_closed ? 'Reopen account' : 'Close account';
  }

  // On a credit card, money out is a charge and money in is a payment.
  const isCard = account?.type === 'credit_card';
  byId('outflow-heading').textContent = isCard ? 'Charge' : 'Payment';
  byId('inflow-heading').textContent = isCard ? 'Payment' : 'Deposit';
}

// --- The register grid ---

// How each status shows in the "Clr" column, as in a paper register:
// c = cleared (the bank has it), R = reconciled (matched to a statement).
const STATUS_MARKS = { uncleared: '', cleared: 'c', reconciled: 'R' };

// Builds one table cell. textContent keeps every value plain text.
function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  if (className) td.className = className;
  return td;
}

// A balance cell, shown in red when below zero (overdrawn, or owed on a card).
function balanceCell(cents) {
  return cell(formatCents(cents), cents < 0 ? 'col-money negative' : 'col-money');
}

function showRegisterMessage(message) {
  const row = document.createElement('tr');
  row.className = 'empty-row';
  const td = cell(message);
  td.colSpan = 9;
  row.append(td);
  byId('register-rows').replaceChildren(row);
  byId('register-balance').textContent = '';
}

// Register state, alongside `accounts` and `selectedId` above:
let currentRegister = null; // last data loaded from /api/register
let editingId = null;       // id of the transaction open for editing, if any
let focusedRowId = null;    // last transaction row you moved to with the keyboard
let lastEnteredDate = null; // new rows start with this date (see newRowDate)

// Fetches the selected account's register (and the payee list for
// autocomplete), then redraws the grid.
async function loadRegister() {
  const accountId = selectedId;
  if (accountId === null) {
    currentRegister = null;
    showRegisterMessage('No account selected.');
    return;
  }

  const [register, payees] = await Promise.all([
    getJson(`/api/register?accountId=${accountId}`),
    getJson('/api/payees'),
  ]);

  // If you clicked another account while this was loading, a newer load is
  // already on its way; drop this one so the grid never shows the wrong account.
  if (accountId !== selectedId) return;

  currentRegister = register;
  fillPayeeOptions(payees);
  renderRows();
}

// The browser's built-in suggestion list for the Payee field.
function fillPayeeOptions(payees) {
  const options = payees.map((payee) => {
    const option = document.createElement('option');
    option.value = payee.name;
    return option;
  });
  byId('payee-options').replaceChildren(...options);
}

// Draws the grid from currentRegister: opening line, one line per
// transaction (or input fields for the one being edited), and the blank
// entry row at the bottom.
function renderRows() {
  const register = currentRegister;
  const account = accounts.find((a) => a.id === selectedId);
  // Closed accounts are read-only: reopen one to change it.
  const canEdit = !account.is_closed;

  // The first row is the opening balance, like the top line of a checkbook.
  const openingRow = document.createElement('tr');
  openingRow.className = 'opening-row';
  openingRow.append(
    cell(register.openingDate),
    cell(''),
    cell('Opening balance'),
    cell(''),
    cell(''),
    cell('', 'col-money'),
    cell('', 'col-clr'),
    cell('', 'col-money'),
    balanceCell(register.openingBalanceCents)
  );

  const rows = register.rows.map((t) =>
    canEdit && t.id === editingId ? buildEditRow(t) : buildViewRow(t, canEdit)
  );
  if (canEdit) rows.push(buildNewRow());

  byId('register-rows').replaceChildren(openingRow, ...rows);
  hideEntryError();

  // The current balance is the last row's balance (or the opening balance if
  // there are no transactions yet).
  const current = register.rows.at(-1)?.balance_cents ?? register.openingBalanceCents;
  const balanceText = byId('register-balance');
  balanceText.textContent = `Balance: ${formatCents(current)}`;
  balanceText.classList.toggle('negative', current < 0);
}

// One signed amount shown across two columns: money out (negative) appears as
// a positive number under Payment/Charge, money in under Deposit.
function splitAmount(amountCents) {
  return amountCents < 0
    ? { outflow: formatCents(-amountCents), inflow: '' }
    : { outflow: '', inflow: formatCents(amountCents) };
}

// A plain (not being edited) transaction line.
function buildViewRow(t, canEdit) {
  const { outflow, inflow } = splitAmount(t.amount_cents);
  const row = document.createElement('tr');
  row.className = 'transaction-row';
  row.dataset.id = t.id;
  row.append(
    cell(t.date),
    cell(t.check_number),
    cell(t.payee),
    cell(t.category),
    cell(t.memo),
    cell(outflow, 'col-money'),
    cell(STATUS_MARKS[t.status], 'col-clr'),
    cell(inflow, 'col-money'),
    balanceCell(t.balance_cents)
  );

  if (canEdit) {
    // "Roving tabindex": only one transaction row is reachable with Tab, so
    // tabbing doesn't stop on every row; ↑/↓ move between rows from there.
    row.tabIndex = t.id === (focusedRowId ?? currentRegister.rows.at(-1)?.id) ? 0 : -1;
    row.addEventListener('click', () => startEdit(t));
    row.addEventListener('focus', () => {
      focusedRowId = t.id;
    });
  }
  return row;
}

// Keyboard control of the transaction lines (when a line, not an input, has
// focus): ↑/↓ move, Enter edits, Delete removes.
byId('register-rows').addEventListener('keydown', (event) => {
  const row = event.target;
  if (!row.classList?.contains('transaction-row')) return;

  const t = currentRegister.rows.find((r) => r.id === Number(row.dataset.id));
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault(); // stop the page scrolling instead
    const next = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (next?.classList.contains('transaction-row')) {
      next.focus();
    } else if (next?.classList.contains('editor-row')) {
      // Down from the last line lands in the entry row.
      next.querySelector('input').focus();
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    startEdit(t);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    runAction(() => deleteTransaction(t));
  }
});

// --- Entering and editing transactions ---

// New rows start with the last date you entered (handy when typing in a run
// of transactions from one statement), or today if you haven't entered any.
function newRowDate() {
  return lastEnteredDate ?? todayText();
}

// Builds a row of input fields. `values` holds the starting text for each
// field; `onSave`/`onCancel` run on Enter/Esc. Returns the <tr> and its inputs.
function buildEditorRow(values, statusMark, { onSave, onCancel }) {
  const makeInput = (name, extra = {}) => {
    const input = document.createElement('input');
    input.name = name;
    input.autocomplete = 'off';
    Object.assign(input, extra);
    return input;
  };

  const fields = {
    date: makeInput('date', { type: 'date', value: values.date }),
    checkNumber: makeInput('checkNumber', { value: values.checkNumber ?? '' }),
    payee: makeInput('payee', { value: values.payee ?? '' }),
    // Categories arrive in milestone 5; the box is here so the layout is final.
    category: makeInput('category', { disabled: true, placeholder: 'later' }),
    memo: makeInput('memo', { value: values.memo ?? '' }),
    outflow: makeInput('outflow', { value: values.outflow ?? '', inputMode: 'decimal', className: 'money-input' }),
    inflow: makeInput('inflow', { value: values.inflow ?? '', inputMode: 'decimal', className: 'money-input' }),
  };
  // Connects the field to the <datalist> of payee names in index.html.
  fields.payee.setAttribute('list', 'payee-options');

  // An amount goes in one column or the other, so typing in one clears the other.
  fields.outflow.addEventListener('input', () => {
    if (fields.outflow.value !== '') fields.inflow.value = '';
  });
  fields.inflow.addEventListener('input', () => {
    if (fields.inflow.value !== '') fields.outflow.value = '';
  });

  const wrap = (input, className) => {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.append(input);
    return td;
  };

  const row = document.createElement('tr');
  row.className = 'editor-row';
  const actionsCell = cell('', 'col-money');
  row.append(
    wrap(fields.date),
    wrap(fields.checkNumber),
    wrap(fields.payee),
    wrap(fields.category),
    wrap(fields.memo),
    wrap(fields.outflow, 'col-money'),
    cell(statusMark, 'col-clr'),
    wrap(fields.inflow, 'col-money'),
    actionsCell
  );

  row.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter') {
      // On the Delete button, Enter should press the button, not save.
      if (event.target.tagName === 'BUTTON') return;
      event.preventDefault();
      if (event.target === fields.payee) {
        // In the Payee box, Enter accepts the suggestion and moves on to Memo,
        // rather than saving before you've finished the line.
        fields.memo.focus();
      } else {
        runAction(onSave);
      }
    }
  });

  return { row, fields, actionsCell };
}

// The blank entry row at the bottom of the register.
function buildNewRow() {
  const { row, fields } = buildEditorRow({ date: newRowDate() }, '', {
    onSave: () => saveNewTransaction(fields),
    onCancel: () => {
      // Esc empties the row but keeps the date.
      for (const [name, input] of Object.entries(fields)) {
        if (name !== 'date') input.value = '';
      }
      hideEntryError();
    },
  });
  row.id = 'new-row';
  return row;
}

// An existing transaction opened for editing, with a Delete button.
function buildEditRow(t) {
  const { row, fields, actionsCell } = buildEditorRow(
    {
      date: t.date,
      checkNumber: t.check_number,
      payee: t.payee,
      memo: t.memo,
      ...splitAmount(t.amount_cents),
    },
    STATUS_MARKS[t.status],
    {
      onSave: () => saveEditedTransaction(t, fields),
      onCancel: () => stopEditing(t.id),
    }
  );

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger small';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => runAction(() => deleteTransaction(t)));
  actionsCell.append(deleteButton);
  return row;
}

// Reads the input fields into what the server expects. Problems are thrown as
// Errors with a `field` to put the cursor back in.
function readFields(fields) {
  const problem = (message, field) => Object.assign(new Error(message), { field });
  const outName = byId('outflow-heading').textContent;
  const inName = byId('inflow-heading').textContent;

  if (!fields.date.value) throw problem('Enter a date.', fields.date);

  const outText = fields.outflow.value.trim();
  const inText = fields.inflow.value.trim();
  if (!outText && !inText) throw problem(`Enter an amount under ${outName} or ${inName}.`, fields.outflow);

  const amountField = outText ? fields.outflow : fields.inflow;
  let cents;
  try {
    cents = parseDollarsToCents(outText || inText);
  } catch (err) {
    throw problem(err.message, amountField);
  }
  // The column says which way the money moved, so a minus sign would be
  // ambiguous. Ask for the other column instead.
  if (cents < 0) {
    throw problem(`Leave out the minus sign; use the ${outText ? inName : outName} column instead.`, amountField);
  }

  return {
    date: fields.date.value,
    checkNumber: fields.checkNumber.value,
    payee: fields.payee.value,
    memo: fields.memo.value,
    amountCents: outText ? -cents : cents,
  };
}

// Reads the fields, or shows the problem under the grid and returns null.
function readFieldsOrShowError(fields) {
  try {
    return readFields(fields);
  } catch (err) {
    showEntryError(err.message);
    err.field?.focus();
    return null;
  }
}

function showEntryError(message) {
  const box = byId('entry-error');
  box.textContent = message;
  box.hidden = false;
}

function hideEntryError() {
  byId('entry-error').hidden = true;
}

// Server-side problems (like a rejected date) are shown the same way as
// problems caught in the page.
async function postOrShowError(url, body) {
  try {
    return await postJson(url, body);
  } catch (err) {
    showEntryError(err.message);
    return null;
  }
}

async function saveNewTransaction(fields) {
  const data = readFieldsOrShowError(fields);
  if (!data) return;
  const saved = await postOrShowError('/api/transactions', { accountId: selectedId, ...data });
  if (!saved) return;

  lastEnteredDate = data.date;
  focusedRowId = saved.id;
  await loadRegister();
  // Ready for the next one.
  byId('new-row')?.querySelector('input[name="date"]').focus();
}

// Changing a reconciled transaction makes the account disagree with a bank
// statement you already matched, so it needs a deliberate yes.
const RECONCILED_WARNING =
  'This transaction was reconciled against a bank statement. ' +
  'Changing it will make the account disagree with that statement.';

function startEdit(t) {
  if (t.status === 'reconciled' && !confirm(`${RECONCILED_WARNING}\n\nEdit it anyway?`)) return;
  editingId = t.id;
  renderRows();
  document.querySelector('.editor-row input[name="date"]').focus();
}

// Closes the editor and puts the keyboard focus back on that line.
function stopEditing(id) {
  editingId = null;
  focusedRowId = id;
  renderRows();
  document.querySelector(`.transaction-row[data-id="${id}"]`)?.focus();
}

async function saveEditedTransaction(t, fields) {
  const data = readFieldsOrShowError(fields);
  if (!data) return;
  if (!(await postOrShowError('/api/transactions/update', { id: t.id, ...data }))) return;

  editingId = null;
  focusedRowId = t.id;
  await loadRegister();
  document.querySelector(`.transaction-row[data-id="${t.id}"]`)?.focus();
}

async function deleteTransaction(t) {
  const amount = formatCents(Math.abs(t.amount_cents));
  const description = [t.date, t.payee ?? t.memo ?? '', amount].join('   ');
  const warning = t.status === 'reconciled' ? `${RECONCILED_WARNING}\n\n` : '';
  if (!confirm(`${warning}Delete this transaction?\n\n${description}\n\nThis cannot be undone.`)) return;

  // Afterwards, keep your place by moving to the line below (or above).
  const rows = currentRegister.rows;
  const index = rows.findIndex((r) => r.id === t.id);
  const neighbor = rows[index + 1] ?? rows[index - 1];

  await postJson('/api/transactions/delete', { id: t.id });
  editingId = null;
  focusedRowId = neighbor?.id ?? null;
  await loadRegister();
  document.querySelector(`.transaction-row[data-id="${focusedRowId}"]`)?.focus();
}

// --- Adding an account ---

const form = byId('add-account-form');

// Today as 'YYYY-MM-DD' in your local time zone (toISOString would use UTC,
// which can be tomorrow's date on a US evening).
function todayText() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function showAddForm() {
  form.reset();
  form.elements.openingDate.value = todayText();
  updateOpeningBalanceLabel();
  byId('add-account-error').hidden = true;
  form.hidden = false;
  byId('show-add-account').hidden = true;
  form.elements.name.focus();
}

function hideAddForm() {
  form.hidden = true;
  byId('show-add-account').hidden = false;
}

// For a credit card you think in "how much do I owe", so ask for that and store
// it as a negative balance (money owed), matching the app's sign convention.
function updateOpeningBalanceLabel() {
  const isCard = form.elements.type.value === 'credit_card';
  byId('opening-balance-label').textContent = isCard ? 'Amount owed' : 'Opening balance';
}

async function saveNewAccount() {
  const fields = form.elements;
  const errorBox = byId('add-account-error');

  let cents;
  try {
    const typed = fields.openingBalance.value.trim();
    cents = typed === '' ? 0 : parseDollarsToCents(typed);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    fields.openingBalance.focus();
    return;
  }
  if (fields.type.value === 'credit_card') cents = -cents;

  try {
    const { id } = await postJson('/api/accounts', {
      name: fields.name.value,
      type: fields.type.value,
      openingBalanceCents: cents,
      openingDate: fields.openingDate.value,
    });
    selectedId = id;
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    return;
  }

  hideAddForm();
  await reloadAccounts();
}

byId('show-add-account').addEventListener('click', showAddForm);
byId('cancel-add-account').addEventListener('click', hideAddForm);
form.elements.type.addEventListener('change', updateOpeningBalanceLabel);
form.addEventListener('submit', (event) => {
  // Stop the browser's default "submit" (which would reload the page);
  // we send the data ourselves with fetch.
  event.preventDefault();
  runAction(saveNewAccount);
});
form.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideAddForm();
});

// --- Actions on the selected account ---

const selectedAccount = () => accounts.find((a) => a.id === selectedId);

byId('rename-account').addEventListener('click', () =>
  runAction(async () => {
    const account = selectedAccount();
    const name = prompt('New name for this account:', account.name);
    if (name === null || name.trim() === '') return; // cancelled or left blank
    await postJson('/api/accounts/rename', { id: account.id, name });
    await reloadAccounts();
  })
);

// Closing is fully reversible (Reopen), so it doesn't ask for confirmation.
byId('toggle-closed').addEventListener('click', () =>
  runAction(async () => {
    const account = selectedAccount();
    await postJson('/api/accounts/set-closed', { id: account.id, isClosed: !account.is_closed });
    await reloadAccounts();
  })
);

// Deleting is permanent, so it always asks first. The server also refuses if
// the account has any transactions.
byId('delete-account').addEventListener('click', () =>
  runAction(async () => {
    const account = selectedAccount();
    const sure = confirm(`Permanently delete the account "${account.name}"?\n\nThis cannot be undone.`);
    if (!sure) return;
    await postJson('/api/accounts/delete', { id: account.id });
    await reloadAccounts();
  })
);

// --- Start ---

runAction(async () => {
  const info = await getJson('/api/info');
  byId('sample-banner').hidden = !info.isSampleData;
  await reloadAccounts();
});
