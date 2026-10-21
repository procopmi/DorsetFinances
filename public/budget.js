// The Budget screen: one month at a time, planned vs. actual money per
// category, grouped like the Categories screen.
//
// The server does all the adding up (src/budget.js); this page shows the
// result, moves between months, and saves the planned amounts you type.
//
// Typing a planned amount: type it and press Enter (moves to the next
// category, like a spreadsheet) or Tab. Esc puts back the saved amount.
// The "Changes apply to" choice above the table says whether it's the usual
// amount from this month on, or a one-off for this month only.

import { byId, getJson, postJson, runAction } from '/api.js';
import { formatCents, parseDollarsToCents } from '/money.js';

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

// Called by main.js whenever this screen is shown, after changing month, and
// after each planned amount is saved.
export async function show() {
  const budget = await getJson(`/api/budget?month=${month}`);

  // Saving one amount redraws the whole table, usually just as you've moved
  // on to the next box. Remember that box (and anything already typed in it)
  // so the redraw doesn't take it away from you.
  const active = document.activeElement;
  const keep = active?.classList.contains('plan-input')
    ? { categoryId: active.dataset.categoryId, value: active.value, edited: active.value !== active.dataset.saved }
    : null;

  byId('budget-month').textContent = monthLabel(month);
  showSummary(budget);
  byId('budget-rows').replaceChildren(
    ...sectionRows('Income', budget.income),
    ...sectionRows('Expenses', budget.expenses),
    row('Net (income minus expenses)', 'total-row', budget.plannedNetCents, budget.actualNetCents, null)
  );

  const input = keep && document.querySelector(`.plan-input[data-category-id="${keep.categoryId}"]`);
  if (input) {
    if (keep.edited) input.value = keep.value;
    input.focus();
    if (!keep.edited) input.select();
  }
}

// The strip above the table: planned vs. actual at a glance.
function showSummary(budget) {
  const item = (label, plannedCents, actualCents) => {
    const span = document.createElement('span');
    span.textContent = `${label}: ${formatCents(actualCents)} of ${formatCents(plannedCents)} planned`;
    return span;
  };
  byId('budget-summary').replaceChildren(
    item('Income', budget.income.plannedCents, budget.income.actualCents),
    item('Expenses', budget.expenses.plannedCents, budget.expenses.actualCents),
    item('Net', budget.plannedNetCents, budget.actualNetCents)
  );
}

// A section's heading, each group with its subs, the uncategorized line (if
// any) and the section total.
function sectionRows(title, section) {
  const rows = [row(title, 'section-row', null, null, null)];
  for (const group of section.groups) {
    rows.push(row(group.name, 'group-row', group.plannedCents, group.actualCents, group.differenceCents));
    for (const sub of group.subs) {
      const name = sub.isHidden ? `${sub.name} (hidden)` : sub.name;
      const subRow = row(name, 'sub-row', null, sub.actualCents, sub.differenceCents);
      subRow.children[1].append(...planInput(sub));
      subRow.classList.toggle('muted', sub.isHidden);
      rows.push(subRow);
    }
  }
  // Uncategorized money has no plan; it still counts against the difference.
  const { uncategorized } = section;
  if (uncategorized.count > 0) {
    const label = `Uncategorized (${uncategorized.count} ${uncategorized.count === 1 ? 'row' : 'rows'})`;
    rows.push(row(label, 'group-row', null, uncategorized.cents, uncategorized.differenceCents));
  }
  rows.push(
    row(`Total ${title.toLowerCase()}`, 'total-row', section.plannedCents, section.actualCents, section.differenceCents)
  );
  return rows;
}

// One table row: a label and three amounts (null leaves a cell blank).
// A negative amount is red: overspent, short of planned income, or a
// category with more refunds than spending.
function row(label, className, plannedCents, actualCents, differenceCents) {
  const tr = document.createElement('tr');
  tr.className = className;

  const name = document.createElement('td');
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  name.textContent = label;
  tr.append(name);

  for (const cents of [plannedCents, actualCents, differenceCents]) {
    const amount = document.createElement('td');
    amount.className = 'col-money';
    if (cents !== null) {
      amount.textContent = formatCents(cents);
      amount.classList.toggle('negative', cents < 0);
    }
    tr.append(amount);
  }
  return tr;
}

// --- Typing planned amounts ---

// The box for a sub's planned amount, plus a • when it's a one-month amount.
// Nothing planned shows as an empty box rather than 0.00, so the categories
// you've actually planned stand out.
function planInput(sub) {
  const input = document.createElement('input');
  input.className = 'plan-input';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.dataset.categoryId = sub.id;
  input.value = sub.plannedCents === 0 && !sub.isOverride ? '' : formatCents(sub.plannedCents);
  // What's saved, so Esc can put it back and a save can tell if it changed.
  input.dataset.saved = input.value;
  input.setAttribute('aria-label', `Planned for ${sub.name}`);

  // "change" fires when you leave the box after editing it (Enter, Tab or a click).
  input.addEventListener('change', () => runAction(() => savePlan(input, sub)));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const boxes = [...document.querySelectorAll('.plan-input')];
      const next = boxes[boxes.indexOf(input) + 1];
      if (next) next.focus();
      else input.blur();
    } else if (event.key === 'Escape') {
      input.value = input.dataset.saved;
      input.blur();
    }
  });

  if (!sub.isOverride) return [input];
  input.classList.add('override');
  input.title = 'Set for this month only. Clear it (with "this month only" chosen) to use the usual amount.';
  const mark = document.createElement('span');
  mark.className = 'override-mark';
  mark.textContent = '•';
  mark.title = input.title;
  return [input, mark];
}

async function savePlan(input, sub) {
  const scope = document.querySelector('input[name="budget-scope"]:checked').value;
  const text = input.value.trim();
  let amountCents;
  if (text === '') {
    // An empty box means "nothing planned", or, for this month only, "go
    // back to the usual amount".
    amountCents = scope === 'month' ? null : 0;
  } else {
    try {
      amountCents = parseDollarsToCents(text);
      if (amountCents < 0) throw new Error("A planned amount can't be negative");
    } catch (err) {
      input.value = input.dataset.saved;
      throw err;
    }
  }
  await postJson('/api/budget/set-plan', { categoryId: sub.id, month, scope, amountCents });
  await show();
}

// --- Moving between months ---

function goTo(newMonth) {
  month = newMonth;
  return show();
}

byId('budget-prev').addEventListener('click', () => runAction(() => goTo(addMonths(month, -1))));
byId('budget-next').addEventListener('click', () => runAction(() => goTo(addMonths(month, 1))));
byId('budget-this-month').addEventListener('click', () => runAction(() => goTo(currentMonth())));
