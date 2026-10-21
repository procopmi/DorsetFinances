// The Reports screen. For now one report, Spending by category, for a period
// chosen with the preset buttons or your own From/To dates.
//
// The server does the adding up (src/reports.js); this page draws the rows
// and bars. Click an amount to see the transactions behind it (drilldown.js). Bars are plain <div>s sized as a percentage of the largest
// group, so there's no charting library.

import { byId, getJson, runAction } from '/api.js';
import { formatCents } from '/money.js';
import { presetRange, todayText } from '/periods.js';
import { drillButton } from '/drilldown.js';

// The period on screen. Starts as this month and is kept while the page is
// open. preset is null when you've typed your own dates.
let period = { preset: 'this-month', ...presetRange('this-month', todayText()) };

// Groups you've opened to see their subs (by id), kept across reloads of
// the report so changing the period doesn't close them.
const openGroups = new Set();

// Called by main.js whenever this screen is shown.
export async function show() {
  byId('report-from').value = period.from;
  byId('report-to').value = period.to;
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === period.preset));
  }

  const report = await getJson(`/api/reports/spending?from=${period.from}&to=${period.to}`);
  renderSpending(report);
}

function renderSpending(report) {
  // Bars are scaled to the largest group, so it fills the column.
  const largest = Math.max(0, ...report.groups.map((g) => g.cents), report.uncategorized.cents);
  const rows = [];

  for (const group of report.groups) {
    const isOpen = openGroups.has(group.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-toggle';
    toggle.textContent = `${isOpen ? '▾' : '▸'} ${group.name}`;
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.addEventListener('click', () => {
      if (isOpen) openGroups.delete(group.id);
      else openGroups.add(group.id);
      renderSpending(report);
    });
    rows.push(row(toggle, group, largest, 'group-row', { categoryId: group.id }));

    if (isOpen) {
      for (const sub of group.subs) {
        const label = sub.isHidden ? `${sub.name} (hidden)` : sub.name;
        rows.push(row(label, sub, largest, 'sub-row', { categoryId: sub.id }));
      }
    }
  }

  const { uncategorized } = report;
  if (uncategorized.count > 0) {
    const label = `Uncategorized (${uncategorized.count} ${uncategorized.count === 1 ? 'row' : 'rows'})`;
    rows.push(row(label, uncategorized, largest, 'group-row', { uncategorized: 'out' }));
  }

  if (rows.length === 0) {
    rows.push(messageRow('No spending in this period.'));
  }
  rows.push(row('Total spending', { cents: report.totalCents, sharePercent: null }, null, 'total-row'));
  byId('spending-rows').replaceChildren(...rows);
}

// One row: name (text, or the group's open/close button), bar, amount and
// share. largest null means no bar (the total row). drill says which
// transactions clicking the amount lists (none for the total row).
function row(label, item, largest, className, drill = null) {
  const tr = document.createElement('tr');
  tr.className = className;

  const name = document.createElement('td');
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  if (typeof label === 'string') name.textContent = label;
  else name.append(label);

  const barCell = document.createElement('td');
  barCell.className = 'col-bar';
  // A category with more refunds than spending has nothing to draw.
  if (largest && item.cents > 0) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${(item.cents / largest) * 100}%`;
    // The browser's own tooltip on hover.
    bar.title = `${formatCents(item.cents)} (${item.sharePercent}% of spending)`;
    barCell.append(bar);
  }

  const amount = document.createElement('td');
  amount.className = 'col-money';
  if (drill) amount.append(drillButton(item.cents, drill, period.from, period.to));
  else amount.textContent = formatCents(item.cents);
  amount.classList.toggle('negative', item.cents < 0);

  const share = document.createElement('td');
  share.className = 'col-money';
  share.textContent = item.sharePercent === null ? '' : `${item.sharePercent}%`;

  tr.append(name, barCell, amount, share);
  return tr;
}

function messageRow(text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 4;
  td.className = 'muted';
  td.textContent = text;
  tr.append(td);
  return tr;
}

// --- Choosing the period ---

for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    period = { preset: button.dataset.preset, ...presetRange(button.dataset.preset, todayText()) };
    runAction(show);
  });
}

// Your own dates: the report reloads once both are filled in and in order.
for (const input of [byId('report-from'), byId('report-to')]) {
  input.addEventListener('change', () => {
    const from = byId('report-from').value;
    const to = byId('report-to').value;
    if (!from || !to || from > to) return;
    period = { preset: null, from, to };
    runAction(show);
  });
}
