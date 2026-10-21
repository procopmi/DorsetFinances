// Drill-down: click an amount on the Budget or Reports screen to see the
// transactions that make it up. Shared by both screens.
//
// The list comes from the server with the same counting rules as the
// amount you clicked, and shows its own total, so you can check they match.
// Handy for finding a transaction in the wrong category.

import { byId, getJson, runAction } from '/api.js';
import { formatCents } from '/money.js';

// Opens the list. what is { categoryId } (a sub, or a group for all its
// subs) or { uncategorized: 'in' | 'out' }; from and to are 'YYYY-MM-DD'.
async function showTransactions(what, from, to) {
  const params = new URLSearchParams({ from, to, ...what });
  const result = await getJson(`/api/transactions/for-category?${params}`);

  byId('drilldown-title').textContent = result.title;
  byId('drilldown-period').textContent =
    `${from} to ${to} · ${result.rows.length} ${result.rows.length === 1 ? 'transaction' : 'transactions'}`;
  byId('drilldown-rows').replaceChildren(...result.rows.map(transactionRow));
  // Amounts in the list use the register's signs (money out negative); the
  // total uses the screen's (spending positive), to match what you clicked.
  byId('drilldown-total').textContent = `Total: ${formatCents(result.totalCents)}`;
  byId('drilldown').showModal();
}

function transactionRow(t) {
  const tr = document.createElement('tr');
  const cells = [t.date, t.account, t.payee ?? '', t.category ?? 'Uncategorized', t.memo ?? ''];
  for (const text of cells) {
    const td = document.createElement('td');
    // textContent (not innerHTML) so names and memos are always plain text.
    td.textContent = text;
    tr.append(td);
  }
  const amount = document.createElement('td');
  amount.className = t.amount_cents < 0 ? 'col-money negative' : 'col-money';
  amount.textContent = formatCents(t.amount_cents);
  tr.append(amount);
  return tr;
}

// A table cell's amount as a button that opens the list. The button looks
// like the plain number (underlined on hover), so the tables still read as
// tables.
export function drillButton(cents, what, from, to) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'drill-link';
  button.textContent = formatCents(cents);
  button.title = 'Show these transactions';
  button.addEventListener('click', () => runAction(() => showTransactions(what, from, to)));
  return button;
}
