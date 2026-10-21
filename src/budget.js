// The Budget screen's arithmetic: turns one month's per-category totals
// (from db.monthActuals) and planned amounts (db.listBudgetPlans and
// db.listBudgetOverrides) into the Income and Expenses sections the page
// shows, with group roll-ups, section totals and the net.
//
// Plain functions with no SQL, so the tests can check the math directly.
//
// Sign convention on this screen (different from the register, on purpose):
// both sections show positive numbers. Income is money that came in; Expenses
// is money spent. So a 50.00 grocery charge (stored as -5000) shows as 5000
// under Expenses, and a 10.00 refund in Groceries brings it back down to 4000.
//
// Difference: positive is always good news.
//   Expenses: planned - actual (money left; negative = overspent).
//   Income:   actual - planned (negative = less came in than planned).

function requireCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error(`budget expects whole cents, got ${cents}`);
  return cents;
}

// The planned amount for one category in one month ('YYYY-MM'):
//   - that month's override, if there is one;
//   - otherwise the standing amount with the latest start month up to and
//     including this month;
//   - otherwise 0 (nothing planned).
// 'YYYY-MM' text sorts in date order, so plain < and > compare months.
// Returns { cents, isOverride }.
export function plannedFor(categoryId, month, plans, overrides) {
  const override = overrides.find((o) => o.category_id === categoryId && o.month === month);
  if (override) return { cents: requireCents(override.amount_cents), isOverride: true };

  let latest = null;
  for (const plan of plans) {
    if (plan.category_id !== categoryId || plan.start_month > month) continue;
    if (!latest || plan.start_month > latest.start_month) latest = plan;
  }
  return { cents: latest ? requireCents(latest.amount_cents) : 0, isOverride: false };
}

// categories: every category (db.listCategories), groups and subs.
// actualRows: db.monthActuals(month).
// plans, overrides: db.listBudgetPlans() and db.listBudgetOverrides(month).
// Returns {
//   income:   { groups, uncategorized: { cents, count, differenceCents }, plannedCents, actualCents, differenceCents },
//   expenses: { same shape },
//   plannedNetCents, actualNetCents   (income minus expenses)
// }
// where each group is { id, name, plannedCents, actualCents, differenceCents,
// subs: [{ id, name, isHidden, plannedCents, isOverride, actualCents, differenceCents }] }.
export function buildBudget(categories, actualRows, { month, plans, overrides }) {
  // Signed register total per category id, refunds and charges added together.
  const signedByCategory = new Map();
  const uncategorizedIn = { cents: 0, count: 0 };
  const uncategorizedOut = { cents: 0, count: 0 };

  for (const row of actualRows) {
    const cents = requireCents(row.total_cents);
    if (row.category_id === null) {
      // Uncategorized money is split by direction, because there's no
      // category to say whether it's income or spending.
      const bucket = row.money_in ? uncategorizedIn : uncategorizedOut;
      bucket.cents += row.money_in ? cents : -cents;
      bucket.count += row.count;
    } else {
      signedByCategory.set(row.category_id, (signedByCategory.get(row.category_id) ?? 0) + cents);
    }
  }

  const planOf = (id) => plannedFor(id, month, plans, overrides);
  const income = buildSection(categories, 'income', signedByCategory, planOf, uncategorizedIn);
  const expenses = buildSection(categories, 'expense', signedByCategory, planOf, uncategorizedOut);
  return {
    income,
    expenses,
    plannedNetCents: income.plannedCents - expenses.plannedCents,
    actualNetCents: income.actualCents - expenses.actualCents,
  };
}

// One section (income or expense groups). A sub belongs to its group's
// section; moving a sub between groups already updates its kind to match.
function buildSection(categories, kind, signedByCategory, planOf, uncategorized) {
  // Income keeps the register's sign (money in is positive); spending flips
  // it, so money out shows as a positive amount spent.
  const flip = kind === 'income' ? 1 : -1;
  const difference = (plannedCents, actualCents) =>
    kind === 'income' ? actualCents - plannedCents : plannedCents - actualCents;

  const groups = categories
    .filter((c) => c.parent_id === null && c.kind === kind)
    .map((group) => {
      const subs = categories
        .filter((c) => c.parent_id === group.id)
        .map((sub) => {
          const planned = planOf(sub.id);
          const actualCents = flip * (signedByCategory.get(sub.id) ?? 0);
          return {
            id: sub.id,
            name: sub.name,
            isHidden: Boolean(sub.is_hidden || group.is_hidden),
            plannedCents: planned.cents,
            isOverride: planned.isOverride,
            actualCents,
            differenceCents: difference(planned.cents, actualCents),
          };
        })
        // A hidden category is retired: show it only when it has a plan or
        // money this month, so the totals still add up.
        .filter((sub) => !sub.isHidden || sub.actualCents !== 0 || sub.plannedCents !== 0);
      const plannedCents = sum(subs, 'plannedCents');
      const actualCents = sum(subs, 'actualCents');
      return { id: group.id, name: group.name, plannedCents, actualCents, differenceCents: difference(plannedCents, actualCents), subs };
    })
    .filter((group) => group.subs.length > 0);

  // Uncategorized money was never planned, so it counts in full against
  // the difference (unplanned spending lowers what's left).
  const plannedCents = sum(groups, 'plannedCents');
  const actualCents = sum(groups, 'actualCents') + uncategorized.cents;
  return {
    groups,
    uncategorized: { ...uncategorized, differenceCents: difference(0, uncategorized.cents) },
    plannedCents,
    actualCents,
    differenceCents: difference(plannedCents, actualCents),
  };
}

const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
