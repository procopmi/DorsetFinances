// The Budget screen: one month at a time, the money that came in and went
// out per category, grouped like the Categories screen.
//
// The server does all the adding up (src/budget.js); this page only shows
// the result and moves between months. For now it shows actuals only;
// planned amounts come in the next step.

import { byId, getJson, runAction } from '/api.js';
import { formatCents } from '/money.js';

// The month on screen, as 'YYYY-MM'. Starts at the current month and is kept
// when you switch to another screen and back.
let month = currentMonth();

function currentMonth() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}

// 'YYYY-MM' moved by a number of months: addMonths('2026-12', 1) -> '2027-01'.
// Uses Date only to handle the year roll-over; no days are involved.
function addMonths(text, count) {
  const [year, monthNumber] = text.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + count, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// 'YYYY-MM' -> "October 2026".
function monthLabel(text) {
  const [year, monthNumber] = text.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Called by main.js whenever this screen is shown, and after changing month.
export async function show() {
  const budget = await getJson(`/api/budget?month=${month}`);
  byId('budget-month').textContent = monthLabel(month);
  byId('budget-rows').replaceChildren(
    ...sectionRows('Income', budget.income),
    ...sectionRows('Expenses', budget.expenses),
    row('Net (income minus expenses)', budget.netCents, 'total-row')
  );
}

// A section's heading, each group with its subs, the uncategorized line (if
// any) and the section total.
function sectionRows(title, section) {
  const rows = [row(title, null, 'section-row')];
  for (const group of section.groups) {
    rows.push(row(group.name, group.actualCents, 'group-row'));
    for (const sub of group.subs) {
      const name = sub.isHidden ? `${sub.name} (hidden)` : sub.name;
      const subRow = row(name, sub.actualCents, 'sub-row');
      subRow.classList.toggle('muted', sub.isHidden);
      rows.push(subRow);
    }
  }
  const { uncategorized } = section;
  if (uncategorized.count > 0) {
    const label = `Uncategorized (${uncategorized.count} ${uncategorized.count === 1 ? 'row' : 'rows'})`;
    rows.push(row(label, uncategorized.cents, 'group-row'));
  }
  rows.push(row(`Total ${title.toLowerCase()}`, section.totalCents, 'total-row'));
  return rows;
}

// One table row: a label and an amount (null leaves the amount blank).
// A negative amount, e.g. a category with more refunds than spending, is red.
function row(label, cents, className) {
  const tr = document.createElement('tr');
  tr.className = className;

  const name = document.createElement('td');
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  name.textContent = label;

  const amount = document.createElement('td');
  amount.className = 'col-money';
  if (cents !== null) {
    amount.textContent = formatCents(cents);
    amount.classList.toggle('negative', cents < 0);
  }

  tr.append(name, amount);
  return tr;
}

// --- Moving between months ---

function goTo(newMonth) {
  month = newMonth;
  return show();
}

byId('budget-prev').addEventListener('click', () => runAction(() => goTo(addMonths(month, -1))));
byId('budget-next').addEventListener('click', () => runAction(() => goTo(addMonths(month, 1))));
byId('budget-this-month').addEventListener('click', () => runAction(() => goTo(currentMonth())));
