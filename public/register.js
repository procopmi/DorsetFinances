// The Register screen: the account sidebar and the transaction grid.
// It runs in the browser, asks the server for data (fetch) and fills in the
// page. The browser never touches the database directly; it only talks to
// /api/ routes.

// The same money.js the server uses (and the tests cover), served at /money.js.
import { parseDollarsToCents, formatCents } from '/money.js';
import { byId, getJson, postJson, runAction, makeButton } from '/api.js';
// rules.js is shared the same way, for picking a category by amount.
import { categoryForAmount } from '/rules.js';

// --- Page state ---
// The accounts as last loaded from the server, and which one is selected.
// After any change we reload from the server rather than patching this list by
// hand, so the page always shows exactly what's in the database.
let accounts = [];
let selectedId = null;

// Called by main.js whenever this screen is shown. Reloading every time means
// renames and merges made on the other screens appear straight away.
export function show() {
  return reloadAccounts();
}

// Chooses the account the register shows next time it's opened (used by the
// Dashboard's account links, just before switching to this screen).
export function selectAccount(id) {
  selectedId = id;
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

  // Money-out / money-in column names suited to the kind of account.
  const headings = COLUMN_HEADINGS[account?.type] ?? COLUMN_HEADINGS.checking;
  byId('outflow-heading').textContent = headings.outflow;
  byId('inflow-heading').textContent = headings.inflow;
}

// On a credit card, money out is a charge and money in is a payment.
const COLUMN_HEADINGS = {
  checking: { outflow: 'Payment', inflow: 'Deposit' },
  savings: { outflow: 'Payment', inflow: 'Deposit' },
  credit_card: { outflow: 'Charge', inflow: 'Payment' },
  investment: { outflow: 'Withdrawal', inflow: 'Deposit' },
};

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
  byId('cleared-balance').textContent = '';
}

// Register state, alongside `accounts` and `selectedId` above:
let currentRegister = null; // last data loaded from /api/register
let editingId = null;       // id of the transaction open for editing, if any
let focusedRowId = null;    // last transaction row you moved to with the keyboard
let lastEnteredDate = null; // new rows start with this date (see newRowDate)

// For the Payee and Category boxes: the payee list (with each payee's default
// category), and one entry per sub-category: { id, label: "Group: Sub",
// groupName, subName, isHidden }.
let payees = [];
let categoryChoices = [];

// Fetches the selected account's register, plus the payee and category lists
// for autocomplete, then redraws the grid.
async function loadRegister() {
  const accountId = selectedId;
  if (accountId === null) {
    currentRegister = null;
    showRegisterMessage('No account selected.');
    return;
  }

  const [register, payeeList, categoryList] = await Promise.all([
    getJson(`/api/register?accountId=${accountId}`),
    getJson('/api/payees'),
    getJson('/api/categories'),
  ]);

  // If you clicked another account while this was loading, a newer load is
  // already on its way; drop this one so the grid never shows the wrong account.
  if (accountId !== selectedId) return;

  currentRegister = register;
  payees = payeeList;
  categoryChoices = buildCategoryChoices(categoryList);
  fillOptions('payee-options', payees.map((p) => p.name));
  // The Category box also offers "Transfer: <account>" for each other open
  // account, after the real categories.
  fillOptions('category-options', [
    ...categoryChoices.filter((c) => !c.isHidden).map((c) => c.label),
    ...transferTargets().map(transferLabel),
  ]);
  renderRows();

  // After jumping to the other half of a transfer, put the cursor on it.
  if (pendingFocusId !== null) {
    document.querySelector(`.transaction-row[data-id="${pendingFocusId}"]`)?.focus();
    pendingFocusId = null;
  }
}

// --- Transfers in the Category box ---

// A row to focus once the register has loaded (see goToOtherHalf).
let pendingFocusId = null;

const transferLabel = (account) => `Transfer: ${account.name}`;

// The accounts you can transfer to from the selected one: every other open account.
function transferTargets() {
  return accounts.filter((a) => a.id !== selectedId && !a.is_closed);
}

// The other account for "Transfer: <name>" typed in the Category box, or
// undefined if the text isn't a transfer. Closed accounts are included so an
// old transfer to an account closed since can still be saved; the server
// refuses closed accounts for new transfers.
function findTransferAccountId(text) {
  const wanted = text.trim().toLowerCase();
  return accounts.find((a) => a.id !== selectedId && transferLabel(a).toLowerCase() === wanted)?.id;
}

// What the Category column shows for a row.
const categoryText = (t) => (t.transfer_id ? `Transfer: ${t.transfer_account}` : t.category);

// Turns the flat category list from the server into "Group: Sub" choices, in
// display order: each group's subs, group by group. A sub counts as hidden
// if it or its group is hidden. Also used by the Payees screen.
export function buildCategoryChoices(categoryList) {
  const groups = categoryList.filter((c) => c.parent_id === null);
  return groups.flatMap((group) =>
    categoryList
      .filter((c) => c.parent_id === group.id)
      .map((sub) => ({
        id: sub.id,
        label: `${group.name}: ${sub.name}`,
        groupName: group.name,
        subName: sub.name,
        isHidden: Boolean(group.is_hidden || sub.is_hidden),
      }))
  );
}

// "Group: Sub" for a category id, or '' if there's none. (Also used by import.js.)
export function categoryLabel(categoryId) {
  return categoryChoices.find((c) => c.id === categoryId)?.label ?? '';
}

// The usual category of the payee with this name, as "Group: Sub", or ''
// if the payee is new or has no default. (Also used by import.js.)
// Given an amount (the import preview knows it; the register's entry row
// doesn't yet when the payee is picked), the payee's amount rule wins.
export function defaultCategoryLabelForPayee(name, amountCents) {
  const payee = findPayee(name);
  if (!payee) return '';
  return amountRuleLabelForPayee(name, amountCents) ?? categoryLabel(payee.default_category_id);
}

// The category the payee's amount rule picks for this amount, as "Group:
// Sub", or null if the payee has no amount rule (or no amount is given).
function amountRuleLabelForPayee(name, amountCents) {
  const payee = findPayee(name);
  if (!payee || payee.threshold_cents === null || amountCents === undefined) return null;
  return categoryLabel(categoryForAmount(payee, amountCents));
}

const findPayee = (name) => {
  const typed = name.trim().toLowerCase();
  return payees.find((p) => p.name.toLowerCase() === typed);
};

// Fills one of the browser's built-in suggestion lists (<datalist>).
function fillOptions(listId, values) {
  const options = values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    return option;
  });
  byId(listId).replaceChildren(...options);
}

// Finds the category for what was typed in the Category box: the full
// "Group: Sub" label, or just the sub's name when only one sub has it
// ("Groceries" works; "Pay" doesn't, as both Cindy and Michael have one).
// Capitalization doesn't matter. Returns null for a blank box and
// undefined when nothing (or more than one thing) matches.
// (Also used by the import preview, import.js.)
export function findCategoryId(text) {
  const wanted = text.trim().toLowerCase();
  if (wanted === '') return null;

  for (const matches of [
    categoryChoices.filter((c) => c.label.toLowerCase() === wanted),
    categoryChoices.filter((c) => c.subName.toLowerCase() === wanted),
  ]) {
    if (matches.length === 1) return matches[0].id;
  }
  return undefined;
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
  // there are no transactions yet). The cleared balance comes from the server
  // and is the one to compare with your bank's online balance.
  const current = register.rows.at(-1)?.balance_cents ?? register.openingBalanceCents;
  showAmount('register-balance', 'Balance', current);
  showAmount('cleared-balance', 'Cleared', register.clearedBalanceCents);

  // "Mark cleared as reconciled" only makes sense when something is cleared.
  const lockButton = byId('reconcile-cleared');
  lockButton.hidden = !canEdit;
  lockButton.disabled = !register.rows.some((r) => r.status === 'cleared');
  // Importing adds rows, so it's not offered for a closed (read-only) account.
  byId('show-import').hidden = !canEdit;
}

// Shows "Label: 1,234.56" in a header element, in red when below zero.
function showAmount(elementId, label, cents) {
  const element = byId(elementId);
  element.textContent = `${label}: ${formatCents(cents)}`;
  element.classList.toggle('negative', cents < 0);
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
  const clrCell = cell(STATUS_MARKS[t.status], 'col-clr');
  row.append(
    cell(t.date),
    cell(t.check_number),
    cell(t.payee),
    cell(categoryText(t)),
    cell(t.memo),
    cell(outflow, 'col-money'),
    clrCell,
    cell(inflow, 'col-money'),
    balanceCell(t.balance_cents)
  );

  if (canEdit) {
    // Clicking the Clr mark toggles cleared, like ticking a paper register.
    // stopPropagation keeps that click from also opening the row for editing.
    clrCell.classList.add('clr-toggle');
    clrCell.title = 'Click (or press Space) to mark cleared / not cleared';
    clrCell.addEventListener('click', (event) => {
      event.stopPropagation();
      runAction(() => toggleCleared(t));
    });

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
// focus): ↑/↓ move, Enter edits, Space toggles cleared, Delete removes.
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
  } else if (event.key === ' ') {
    event.preventDefault(); // Space would otherwise scroll the page
    runAction(() => toggleCleared(t));
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    runAction(() => deleteTransaction(t));
  }
});

// --- Cleared and reconciled ---

// Blank ↔ c. A reconciled (R) item is locked, so it asks before unlocking it
// back to cleared.
async function toggleCleared(t) {
  let status;
  if (t.status === 'reconciled') {
    if (!confirm('This transaction is reconciled. Unlock it (set it back to cleared)?')) return;
    status = 'cleared';
  } else {
    status = t.status === 'cleared' ? 'uncleared' : 'cleared';
  }

  await postJson('/api/transactions/set-status', { id: t.id, status });
  focusedRowId = t.id;
  await loadRegister();
  // Keep your place, so you can work down the list pressing ↓ and Space.
  document.querySelector(`.transaction-row[data-id="${t.id}"]`)?.focus();
}

// Once the Cleared figure matches your bank's online balance, lock in every
// cleared item as reconciled (R), which makes it ask before later edits.
byId('reconcile-cleared').addEventListener('click', () =>
  runAction(async () => {
    const count = currentRegister.rows.filter((r) => r.status === 'cleared').length;
    const message =
      `Cleared balance is ${formatCents(currentRegister.clearedBalanceCents)}.\n\n` +
      `If this matches your bank, ${count} cleared transaction(s) will be marked R (reconciled).`;
    if (!confirm(message)) return;

    await postJson('/api/accounts/reconcile-cleared', { accountId: selectedId });
    await loadRegister();
  })
);

// --- Exporting to CSV ---

const exportForm = byId('export-form');

byId('show-export').addEventListener('click', () => {
  exportForm.hidden = false;
  exportForm.elements.scope.focus();
});

const hideExport = () => {
  exportForm.hidden = true;
};
byId('cancel-export').addEventListener('click', hideExport);
exportForm.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideExport();
});

// Asks the server for the file and saves it. fetch (rather than just opening
// the link) lets a problem, like a From date after the To date, show as a
// message instead of replacing the page.
exportForm.addEventListener('submit', (event) => {
  event.preventDefault(); // we send it ourselves; don't reload the page
  runAction(async () => {
    const { scope, from, to } = exportForm.elements;
    const params = new URLSearchParams({
      accountId: scope.value === 'all' ? 'all' : String(selectedId),
      from: from.value,
      to: to.value,
    });

    const response = await fetch(`/api/export?${params}`);
    if (!response.ok) throw new Error((await response.json()).error);

    // The server names the file (e.g. "Everyday-Checking-2026-10-16.csv").
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export.csv';

    // Hand the file to the browser's normal download by "clicking" a
    // temporary link to it.
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Free the temporary file a moment later; doing it immediately can cancel
    // the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    hideExport();
  });
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
    category: makeInput('category', { value: values.category ?? '' }),
    memo: makeInput('memo', { value: values.memo ?? '' }),
    outflow: makeInput('outflow', { value: values.outflow ?? '', inputMode: 'decimal', className: 'money-input' }),
    inflow: makeInput('inflow', { value: values.inflow ?? '', inputMode: 'decimal', className: 'money-input' }),
  };
  // Connects each box to its <datalist> of suggestions in index.html.
  fields.payee.setAttribute('list', 'payee-options');
  fields.category.setAttribute('list', 'category-options');

  // The category label this row last filled in by itself, if any. The row
  // only ever replaces a category that is blank or still shows this label,
  // so a category you typed or picked yourself is never overwritten.
  let autoFilledLabel = null;
  const mayAutoFill = () => {
    const current = fields.category.value.trim();
    return current === '' || current === autoFilledLabel;
  };
  const autoFill = (label) => {
    fields.category.value = label;
    autoFilledLabel = label;
  };

  // The amount typed so far, in cents (the sign doesn't matter to an amount
  // rule), or undefined while it's blank or half-typed ("1." or "abc").
  const typedAmountCents = () => {
    const text = (fields.outflow.value || fields.inflow.value).trim();
    if (text === '') return undefined;
    try {
      return parseDollarsToCents(text);
    } catch {
      return undefined;
    }
  };

  // Once a payee is chosen, fill in the category last used with it (or its
  // amount rule's choice, if an amount is already there), unless you've
  // already typed a category. ("change" fires when you leave the box.)
  fields.payee.addEventListener('change', () => {
    if (fields.category.value.trim() !== '') return;
    autoFill(defaultCategoryLabelForPayee(fields.payee.value, typedAmountCents()));
  });

  // As the amount is typed, a payee with an amount rule ("under $100.00 →
  // Life - Cindy, otherwise → Life - Michael") switches the category to
  // match. Typing 140 shows Cindy for "1" and "14", then Michael: it's only
  // a suggestion until you save.
  const applyAmountRule = () => {
    const label = amountRuleLabelForPayee(fields.payee.value, typedAmountCents());
    if (label !== null && mayAutoFill()) autoFill(label);
  };

  // An amount goes in one column or the other, so typing in one clears the other.
  fields.outflow.addEventListener('input', () => {
    if (fields.outflow.value !== '') fields.inflow.value = '';
    applyAmountRule();
  });
  fields.inflow.addEventListener('input', () => {
    if (fields.inflow.value !== '') fields.outflow.value = '';
    applyAmountRule();
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
      // In the Payee and Category boxes, Enter accepts the suggestion and moves
      // on to the next box, rather than saving before you've finished the line.
      if (event.target === fields.payee) {
        fields.category.focus();
      } else if (event.target === fields.category) {
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

// An existing transaction opened for editing, with its action buttons:
// Delete always; for a transfer, "Other side" and "Unlink"; otherwise
// "Link…" to join it with its other half in another account.
function buildEditRow(t) {
  const { row, fields, actionsCell } = buildEditorRow(
    {
      date: t.date,
      checkNumber: t.check_number,
      payee: t.payee,
      category: categoryText(t),
      memo: t.memo,
      ...splitAmount(t.amount_cents),
    },
    STATUS_MARKS[t.status],
    {
      onSave: () => saveEditedTransaction(t, fields),
      onCancel: () => stopEditing(t.id),
    }
  );

  const buttons = [makeButton('Delete', () => deleteTransaction(t), 'danger small')];
  if (t.transfer_id) {
    buttons.push(
      makeButton('Other side', async () => goToOtherHalf(t), 'small'),
      makeButton('Unlink', () => unlinkTransfer(t), 'small')
    );
  } else {
    buttons.push(makeButton('Link…', () => linkAsTransfer(t), 'small'));
  }
  actionsCell.classList.add('row-actions');
  actionsCell.append(...buttons);
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

  // The Category box holds either "Transfer: <account>" or a category.
  // Categories are a fixed list (managed on their own screen), so unlike
  // payees, an unknown name is a mistake rather than something to create.
  const transferAccountId = findTransferAccountId(fields.category.value) ?? null;
  const categoryId = transferAccountId ? null : findCategoryId(fields.category.value);
  if (categoryId === undefined) {
    throw problem(
      `"${fields.category.value.trim()}" doesn't match one category. Pick one from the suggestions.`,
      fields.category
    );
  }

  return {
    date: fields.date.value,
    checkNumber: fields.checkNumber.value,
    payee: fields.payee.value,
    categoryId,
    transferAccountId,
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

// Changing a reconciled transaction makes the account disagree with the bank
// balance you already checked it against, so it needs a deliberate yes. For
// a transfer, edits reach the other half too, so its status counts as well.
const RECONCILED_WARNING =
  'This transaction (or the other side of this transfer) is reconciled: it was checked against your bank. ' +
  'Changing it will make the account disagree with the bank.';

const isLocked = (t) => t.status === 'reconciled' || t.transfer_status === 'reconciled';

function startEdit(t) {
  if (isLocked(t) && !confirm(`${RECONCILED_WARNING}\n\nEdit it anyway?`)) return;
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
  const warning = isLocked(t) ? `${RECONCILED_WARNING}\n\n` : '';
  const bothSides = t.transfer_id
    ? `\n\nThis is a transfer with "${t.transfer_account}". Both sides will be deleted.`
    : '';
  const message = `${warning}Delete this transaction?\n\n${description}${bothSides}\n\nThis cannot be undone.`;
  if (!confirm(message)) return;

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

// --- Transfer actions ---

// Switches to the other account and puts the cursor on the matching row.
function goToOtherHalf(t) {
  selectedId = t.transfer_account_id;
  editingId = null;
  focusedRowId = t.transfer_id;
  pendingFocusId = t.transfer_id;
  render(); // redraws the sidebar and loads that account's register
}

// Turns the transfer back into two ordinary rows. Nothing is deleted, so it
// doesn't need a warning beyond saying what happens.
async function unlinkTransfer(t) {
  const message =
    `Unlink this transfer with "${t.transfer_account}"?\n\n` +
    'Both rows stay, as ordinary uncategorized transactions.';
  if (!confirm(message)) return;
  await postJson('/api/transfers/unlink', { id: t.id });
  editingId = null;
  focusedRowId = t.id;
  await loadRegister();
}

// Joins this row with its other half in another account, e.g. when both
// banks' CSV downloads included the same payment. Lists rows with the
// opposite amount within a week, and you type the number of the right one.
async function linkAsTransfer(t) {
  const candidates = await getJson(`/api/transfers/candidates?id=${t.id}`);
  if (candidates.length === 0) {
    alert(
      'No matching row in your other accounts: it needs the opposite amount ' +
        `(${formatCents(-t.amount_cents)}), dated within a week, and not already a transfer.`
    );
    return;
  }

  const lines = candidates.map(
    (c, i) => `${i + 1})  ${c.account}   ${c.date}   ${c.payee ?? c.memo ?? ''}   ${formatCents(c.amount_cents)}`
  );
  const answer = prompt(
    `Link as a transfer with which row? Type its number.\n\n${lines.join('\n')}\n\n` +
      'Both rows will lose their categories (a transfer is not income or spending).',
    candidates.length === 1 ? '1' : ''
  );
  if (answer === null) return; // cancelled
  const chosen = candidates[Number(answer) - 1];
  if (!chosen) {
    alert(`"${answer}" isn't one of the numbers listed.`);
    return;
  }

  await postJson('/api/transfers/link', { id: t.id, otherId: chosen.id });
  editingId = null;
  focusedRowId = t.id;
  await loadRegister();
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

// The account shown in the register. (Also used by import.js.)
export const selectedAccount = () => accounts.find((a) => a.id === selectedId);

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
