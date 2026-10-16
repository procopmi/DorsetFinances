// Runs in the browser. It asks the server for data (fetch) and fills in the page.
// The browser never touches the database directly; it only talks to /api/ routes.

// The same money.js the server uses (and the tests cover), served at /money.js.
import { parseDollarsToCents } from '/money.js';

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
