// The Reports screen: a choice of report (Spending by category, Monthly
// trend, Income vs. expenses) for a period chosen with the preset buttons or your own From/To
// dates.
//
// The server does the adding up (src/reports.js); this page draws the rows
// and bars. Bars are plain <div>s sized as a percentage of the largest group,
// so there's no charting library (the Income vs. expenses chart is in
// cashflow-chart.js). Click an amount to see the transactions
// behind it (drilldown.js).

import { byId, getJson, runAction } from '/api.js';
import { formatCents } from '/money.js';
import { presetRange, todayText, monthWithin } from '/periods.js';
import { drillButton } from '/drilldown.js';
import { cashFlowChart } from '/cashflow-chart.js';

// The report and period on screen. Both are kept while the page is open.
// preset is null when you've typed your own dates.
let view = 'spending';
let period = { preset: 'this-month', ...presetRange('this-month', todayText()) };

// Groups you've opened to see their subs (by id), shared by both reports and
// kept when the period changes, so they don't close on you.
const openGroups = new Set();

// Called by main.js whenever this screen is shown, and after any change of
// report or period.
export async function show() {
  byId('report-from').value = period.from;
  byId('report-to').value = period.to;
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === period.preset));
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
  byId('spending-report').hidden = view !== 'spending';
  byId('trend-report').hidden = view !== 'trend';
  byId('cashflow-report').hidden = view !== 'cashflow';

  const range = `from=${period.from}&to=${period.to}`;
  if (view === 'spending') renderSpending(await getJson(`/api/reports/spending?${range}`));
  else if (view === 'trend') renderTrend(await getJson(`/api/reports/trend?${range}`));
  else renderCashFlow(await getJson(`/api/reports/cashflow?${range}`));
}

// A group's name as a button that opens or closes its subs, then redraws
// the report with redraw().
function groupToggle(group, redraw) {
  const isOpen = openGroups.has(group.id);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'group-toggle';
  toggle.textContent = `${isOpen ? '▾' : '▸'} ${group.name}`;
  toggle.setAttribute('aria-expanded', String(isOpen));
  toggle.addEventListener('click', () => {
    if (isOpen) openGroups.delete(group.id);
    else openGroups.add(group.id);
    redraw();
  });
  return toggle;
}

const subLabel = (sub) => (sub.isHidden ? `${sub.name} (hidden)` : sub.name);
const uncategorizedLabel = (count) => `Uncategorized (${count} ${count === 1 ? 'row' : 'rows'})`;

// A table cell; content is text, or an element such as a button.
function cell(content, className = '') {
  const td = document.createElement('td');
  td.className = className;
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  if (typeof content === 'string') td.textContent = content;
  else td.append(content);
  return td;
}

function messageRow(text, columns) {
  const tr = document.createElement('tr');
  const td = cell(text, 'muted');
  td.colSpan = columns;
  tr.append(td);
  return tr;
}

// --- Spending by category ---

function renderSpending(report) {
  // Bars are scaled to the largest group, so it fills the column.
  const largest = Math.max(0, ...report.groups.map((g) => g.cents), report.uncategorized.cents);
  const redraw = () => renderSpending(report);
  const rows = [];

  for (const group of report.groups) {
    rows.push(spendingRow(groupToggle(group, redraw), group, largest, 'group-row', { categoryId: group.id }));
    if (openGroups.has(group.id)) {
      for (const sub of group.subs) {
        rows.push(spendingRow(subLabel(sub), sub, largest, 'sub-row', { categoryId: sub.id }));
      }
    }
  }

  const { uncategorized } = report;
  if (uncategorized.count > 0) {
    rows.push(spendingRow(uncategorizedLabel(uncategorized.count), uncategorized, largest, 'group-row', { uncategorized: 'out' }));
  }

  if (rows.length === 0) rows.push(messageRow('No spending in this period.', 4));
  rows.push(spendingRow('Total spending', { cents: report.totalCents, sharePercent: null }, null, 'total-row'));
  byId('spending-rows').replaceChildren(...rows);
}

// One row: name (text, or the group's open/close button), bar, amount and
// share. largest null means no bar (the total row). drill says which
// transactions clicking the amount lists (none for the total row).
function spendingRow(label, item, largest, className, drill = null) {
  const tr = document.createElement('tr');
  tr.className = className;

  const barCell = cell('', 'col-bar');
  // A category with more refunds than spending has nothing to draw.
  if (largest && item.cents > 0) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${(item.cents / largest) * 100}%`;
    // The browser's own tooltip on hover.
    bar.title = `${formatCents(item.cents)} (${item.sharePercent}% of spending)`;
    barCell.append(bar);
  }

  const amount = cell(drill ? drillButton(item.cents, drill, period.from, period.to) : formatCents(item.cents), 'col-money');
  amount.classList.toggle('negative', item.cents < 0);
  const share = cell(item.sharePercent === null ? '' : `${item.sharePercent}%`, 'col-money');

  tr.append(cell(label), barCell, amount, share);
  return tr;
}

// --- Monthly trend ---

// 'YYYY-MM' -> "Jan 26".
function shortMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function headerCell(text, className = '') {
  const th = document.createElement('th');
  th.className = className;
  th.textContent = text;
  return th;
}

function renderTrend(report) {
  byId('trend-head').replaceChildren(
    headerCell('Category'),
    ...report.months.map((month) => headerCell(shortMonth(month), 'col-money')),
    headerCell('Total', 'col-money col-summary'),
    headerCell('Average', 'col-money')
  );

  const redraw = () => renderTrend(report);
  const columns = report.months.length + 3;
  const rows = [];
  for (const group of report.groups) {
    rows.push(trendRow(groupToggle(group, redraw), group, report.months, 'group-row', { categoryId: group.id }));
    if (openGroups.has(group.id)) {
      for (const sub of group.subs) {
        rows.push(trendRow(subLabel(sub), sub, report.months, 'sub-row', { categoryId: sub.id }));
      }
    }
  }
  const { uncategorized } = report;
  if (uncategorized.count > 0) {
    rows.push(trendRow(uncategorizedLabel(uncategorized.count), uncategorized, report.months, 'group-row', { uncategorized: 'out' }));
  }
  if (rows.length === 0) rows.push(messageRow('No spending in this period.', columns));
  rows.push(trendRow('Total spending', report.total, report.months, 'total-row'));
  byId('trend-rows').replaceChildren(...rows);
}

// One row of the grid: name, one amount per month, total and average.
// With drill, each month's amount lists that month's transactions (only the
// days inside the period, so the list matches the cell) and the total lists
// the whole period's. A month with nothing is left blank.
function trendRow(label, line, months, className, drill = null) {
  const tr = document.createElement('tr');
  tr.className = className;
  tr.append(cell(label));

  const amountCell = (cents, from, to, className) => {
    const td = cell(drill ? drillButton(cents, drill, from, to) : formatCents(cents), className);
    td.classList.toggle('negative', cents < 0);
    return td;
  };

  line.cells.forEach((cents, i) => {
    if (cents === 0) {
      tr.append(cell('', 'col-money'));
      return;
    }
    const { from, to } = monthWithin(months[i], period.from, period.to);
    tr.append(amountCell(cents, from, to, 'col-money'));
  });
  tr.append(amountCell(line.totalCents, period.from, period.to, 'col-money col-summary'));
  // The average isn't a set of transactions, so it's never clickable.
  const average = cell(formatCents(line.averageCents), 'col-money');
  average.classList.toggle('negative', line.averageCents < 0);
  tr.append(average);
  return tr;
}

// --- Income vs. expenses ---

function renderCashFlow(report) {
  byId('cashflow-chart').replaceChildren(cashFlowChart(report.months, shortMonth));

  const moneyRow = (label, item, className = '') => {
    const tr = document.createElement('tr');
    tr.className = className;
    const net = cell(formatCents(item.netCents), 'col-money');
    net.classList.toggle('negative', item.netCents < 0);
    tr.append(
      cell(label),
      cell(formatCents(item.inCents), 'col-money'),
      cell(formatCents(item.outCents), 'col-money'),
      net
    );
    return tr;
  };
  byId('cashflow-rows').replaceChildren(
    ...report.months.map((m) => moneyRow(shortMonth(m.month), m)),
    moneyRow('Total', report.total, 'total-row')
  );
}

// --- Choosing the report and period ---

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    runAction(show);
  });
}

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
