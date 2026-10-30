// The Reports screen's arithmetic. Plain functions with no SQL, so the tests
// can check the math directly.
//
// Counting rules are the Budget screen's (both start from sumActuals in
// budget.js): every account, transfers left out, spending shown as a positive
// amount with refunds lowering their category, and uncategorized money shown
// as its own line.

import { sumActuals, buildBudget } from './budget.js';

// Where the money went over a period: expense groups, largest first, each
// with its subs (largest first) and its share of all spending.
// categories: db.listCategories(); actualRows: db.actualsBetween(from, to).
// Returns {
//   groups: [{ id, name, cents, sharePercent, subs: [{ id, name, isHidden, cents, sharePercent }] }],
//   uncategorized: { cents, count, sharePercent },
//   totalCents
// }
// Only categories with money in the period are listed; a report is about
// where money went, so empty categories would just be noise.
export function spendingByCategory(categories, actualRows) {
  return byCategory(categories, actualRows, 'expense');
}

// The work behind spendingByCategory, for either kind of category, so the
// trend report can add up income exactly the way it adds up spending.
//   'expense': money out is negative in the register, so the sign is flipped
//              to show spending as positive; uncategorized = money that went out.
//   'income':  money in is already positive, so the sign is kept (a negative
//              entry, like a clawback, lowers its category);
//              uncategorized = money that came in.
function byCategory(categories, actualRows, kind) {
  const { signedByCategory, uncategorizedIn, uncategorizedOut } = sumActuals(actualRows);
  const sign = kind === 'expense' ? -1 : 1;
  const uncategorized = kind === 'expense' ? uncategorizedOut : uncategorizedIn;

  const groups = categories
    .filter((c) => c.parent_id === null && c.kind === kind)
    .map((group) => {
      const subs = categories
        .filter((c) => c.parent_id === group.id)
        .map((sub) => ({
          id: sub.id,
          name: sub.name,
          isHidden: Boolean(sub.is_hidden || group.is_hidden),
          cents: sign * (signedByCategory.get(sub.id) ?? 0),
        }))
        .filter((sub) => sub.cents !== 0)
        .sort((a, b) => b.cents - a.cents);
      return { id: group.id, name: group.name, cents: subs.reduce((sum, sub) => sum + sub.cents, 0), subs };
    })
    .filter((group) => group.subs.length > 0)
    .sort((a, b) => b.cents - a.cents);

  const totalCents = groups.reduce((sum, g) => sum + g.cents, 0) + uncategorized.cents;

  // Share of the section's total, as a whole percent. This is for display only
  // (the amounts themselves stay in exact cents), so ordinary division is fine.
  // Shares can add up to 99 or 101 because of rounding.
  const share = (cents) => (totalCents > 0 ? Math.round((cents * 100) / totalCents) : 0);
  for (const group of groups) {
    group.sharePercent = share(group.cents);
    for (const sub of group.subs) sub.sharePercent = share(sub.cents);
  }

  return {
    groups,
    uncategorized: { ...uncategorized, sharePercent: share(uncategorized.cents) },
    totalCents,
  };
}

// Income and spending per month: categories down the side, months across,
// with a total and a monthly average per row. Two sections, Income then
// Expenses, and a Net row (income minus spending) under them. Each month of
// a section is worked out by byCategory above, so a month's Expenses column
// always equals that month's Spending report.
// categories: db.listCategories(); monthlyRows: db.monthlyActualsBetween(from, to);
// months: periods.monthsBetween(from, to).
// Every line is { cells: [cents per month], totalCents, averageCents }. Returns {
//   months,
//   income:   section,
//   expenses: section,
//   net: line
// }
// where a section is {
//   groups: [{ id, name, ...line, subs: [{ id, name, isHidden, ...line }] }],
//   uncategorized: { ...line, count },
//   total: line
// }
export function monthlyTrend(categories, monthlyRows, months) {
  const income = trendSection(categories, monthlyRows, months, 'income');
  const expenses = trendSection(categories, monthlyRows, months, 'expense');
  return {
    months,
    income,
    expenses,
    net: line(income.total.cells.map((cents, i) => cents - expenses.total.cells[i])),
  };
}

// One section of the trend (kind 'income' or 'expense').
// Groups and subs are largest total first, and only those with money in
// some month are listed.
function trendSection(categories, monthlyRows, months, kind) {
  const reports = months.map((month) =>
    byCategory(categories, monthlyRows.filter((row) => row.month === month), kind)
  );
  // Per month, a look-up from group id (or sub id) to that month's amount.
  const groupCents = reports.map((report) => new Map(report.groups.map((g) => [g.id, g.cents])));
  const subCents = reports.map(
    (report) => new Map(report.groups.flatMap((g) => g.subs).map((s) => [s.id, s.cents]))
  );

  const groups = categories
    .filter((c) => c.parent_id === null && c.kind === kind)
    .map((group) => {
      const subs = categories
        .filter((c) => c.parent_id === group.id)
        .map((sub) => ({
          id: sub.id,
          name: sub.name,
          isHidden: Boolean(sub.is_hidden || group.is_hidden),
          ...line(subCents.map((m) => m.get(sub.id) ?? 0)),
        }))
        .filter((sub) => sub.cells.some((cents) => cents !== 0))
        .sort((a, b) => b.totalCents - a.totalCents);
      return { id: group.id, name: group.name, ...line(groupCents.map((m) => m.get(group.id) ?? 0)), subs };
    })
    .filter((group) => group.subs.length > 0)
    .sort((a, b) => b.totalCents - a.totalCents);

  return {
    groups,
    uncategorized: {
      ...line(reports.map((r) => r.uncategorized.cents)),
      count: reports.reduce((sum, r) => sum + r.uncategorized.count, 0),
    },
    total: line(reports.map((r) => r.totalCents)),
  };
}

// Money in vs. money out per month, and the net (in minus out).
//   In:  income categories plus uncategorized money in;
//   Out: spending, as in Spending by category (uncategorized money out included).
// Each month is the Budget screen's own actual figures for that month (via
// buildBudget, with no plans), so the net matches the Budget screen's.
// Returns { months: [{ month, inCents, outCents, netCents }], total: { inCents, outCents, netCents } }.
export function cashFlow(categories, monthlyRows, months) {
  const noPlans = { plans: [], overrides: [] };
  const rows = months.map((month) => {
    const budget = buildBudget(categories, monthlyRows.filter((row) => row.month === month), { month, ...noPlans });
    return {
      month,
      inCents: budget.income.actualCents,
      outCents: budget.expenses.actualCents,
      netCents: budget.actualNetCents,
    };
  });
  const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);
  return { months: rows, total: { inCents: total('inCents'), outCents: total('outCents'), netCents: total('netCents') } };
}

// --- Dashboard ---

// The expense categories furthest over plan in a budget (from buildBudget),
// most over first: [{ id, group, name, plannedCents, actualCents, overCents }].
// Only categories actually over plan are listed, so there may be fewer.
export function overPlan(budget, count) {
  return budget.expenses.groups
    .flatMap((group) => group.subs.map((sub) => ({ group: group.name, ...sub })))
    .filter((sub) => sub.differenceCents < 0)
    .sort((a, b) => a.differenceCents - b.differenceCents)
    .slice(0, count)
    .map((sub) => ({
      id: sub.id,
      group: sub.group,
      name: sub.name,
      plannedCents: sub.plannedCents,
      actualCents: sub.actualCents,
      overCents: -sub.differenceCents,
    }));
}

// This month's biggest spending groups (from spendingByCategory), each next
// to the same group last month (0 if it had none):
// [{ id, name, cents, lastMonthCents }].
export function topSpendingGroups(thisMonth, lastMonth, count) {
  const lastById = new Map(lastMonth.groups.map((g) => [g.id, g.cents]));
  return thisMonth.groups
    .slice(0, count)
    .map((g) => ({ id: g.id, name: g.name, cents: g.cents, lastMonthCents: lastById.get(g.id) ?? 0 }));
}

// One row of the trend: its monthly amounts, their total, and the average
// month. The average is rounded to the nearest cent (so 100.00 over 3 months
// shows 33.33); the total is exact.
function line(cells) {
  const totalCents = cells.reduce((sum, cents) => sum + cents, 0);
  return { cells, totalCents, averageCents: cells.length > 0 ? Math.round(totalCents / cells.length) : 0 };
}
