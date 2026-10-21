// The Dashboard: one screen with the things worth a glance.
//   - Accounts: each open account's balance and cleared balance (click a
//     name to open its register);
//   - This month's budget: planned vs. actual, and the categories furthest
//     over plan;
//   - Top spending: this month's biggest groups next to last month's.
//
// Everything is worked out by the server (GET /api/dashboard), with the same
// rules as the Register, Budget and Reports screens.

import { byId, getJson, openScreen } from '/api.js';
import { formatCents } from '/money.js';
import { selectAccount } from '/register.js';

// Called by main.js whenever this screen is shown.
export async function show() {
  const data = await getJson('/api/dashboard');
  const [year, monthNumber] = data.month.split('-').map(Number);
  byId('dashboard-month').textContent = new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  showAccounts(data);
  showBudget(data);
  showTopSpending(data);
}

// A table cell: text (or an element such as a button); amounts are
// right-aligned and red when negative.
function cell(content, cents = null) {
  const td = document.createElement('td');
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  if (typeof content === 'string') td.textContent = content;
  else td.append(content);
  if (cents !== null) {
    td.className = 'col-money';
    td.classList.toggle('negative', cents < 0);
  }
  return td;
}

const money = (cents) => cell(formatCents(cents), cents);

function row(cells, className = '') {
  const tr = document.createElement('tr');
  tr.className = className;
  tr.append(...cells);
  return tr;
}

function messageRow(text, columns) {
  const td = cell(text);
  td.colSpan = columns;
  td.className = 'muted';
  return row([td]);
}

function showAccounts(data) {
  const rows = data.accounts.map((account) => {
    // The name opens that account's register.
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link-button';
    link.textContent = account.name;
    link.addEventListener('click', () => {
      selectAccount(account.id);
      openScreen('register');
    });
    return row([cell(link), money(account.balance_cents), money(account.cleared_cents)]);
  });
  if (rows.length === 0) rows.push(messageRow('No open accounts.', 3));
  // Cards owe money (negative), so this is what you have minus what you owe.
  else rows.push(row([cell('All accounts'), money(data.accountsTotalCents), cell('')], 'total-row'));
  byId('dashboard-accounts').replaceChildren(...rows);
}

function showBudget(data) {
  const { budget } = data;
  const item = (label, plannedCents, actualCents) => {
    const span = document.createElement('span');
    span.textContent = `${label}: ${formatCents(actualCents)} of ${formatCents(plannedCents)} planned`;
    return span;
  };
  byId('dashboard-budget').replaceChildren(
    item('Income', budget.income.plannedCents, budget.income.actualCents),
    item('Expenses', budget.expenses.plannedCents, budget.expenses.actualCents),
    item('Net', budget.plannedNetCents, budget.actualNetCents)
  );

  const rows = data.overPlan.map((sub) => {
    // "Over by" is a positive amount, in red because it's bad news.
    const over = money(sub.overCents);
    over.classList.add('negative');
    return row([cell(`${sub.group}: ${sub.name}`), money(sub.plannedCents), money(sub.actualCents), over]);
  });
  if (rows.length === 0) rows.push(messageRow('Nothing is over plan this month.', 4));
  byId('dashboard-over').replaceChildren(...rows);
}

function showTopSpending(data) {
  const rows = data.topSpending.map((group) =>
    row([cell(group.name), money(group.cents), money(group.lastMonthCents)])
  );
  if (rows.length === 0) rows.push(messageRow('No spending yet this month.', 3));
  byId('dashboard-top').replaceChildren(...rows);
}

// "Open Budget →" and "Open Reports →".
for (const button of document.querySelectorAll('[data-open-screen]')) {
  button.addEventListener('click', () => openScreen(button.dataset.openScreen));
}
