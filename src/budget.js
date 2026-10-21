// The Budget screen's arithmetic: turns one month's per-category totals
// (from db.monthActuals) into the Income and Expenses sections the page shows,
// with group roll-ups and section totals.
//
// Plain functions with no SQL, so the tests can check the math directly.
//
// Sign convention on this screen (different from the register, on purpose):
// both sections show positive numbers. Income is money that came in; Expenses
// is money spent. So a 50.00 grocery charge (stored as -5000) shows as 5000
// under Expenses, and a 10.00 refund in Groceries brings it back down to 4000.

function requireCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error(`budget expects whole cents, got ${cents}`);
  return cents;
}

// categories: every category (db.listCategories), groups and subs.
// actualRows: db.monthActuals(month).
// Returns {
//   income:   { groups: [...], uncategorized: { cents, count }, totalCents },
//   expenses: { same shape },
//   netCents  (income total minus expenses total)
// }
// where each group is { id, name, actualCents, subs: [{ id, name, isHidden, actualCents }] }.
export function buildBudget(categories, actualRows) {
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

  const income = buildSection(categories, 'income', signedByCategory, uncategorizedIn);
  const expenses = buildSection(categories, 'expense', signedByCategory, uncategorizedOut);
  return { income, expenses, netCents: income.totalCents - expenses.totalCents };
}

// One section (income or expense groups). A sub belongs to its group's
// section; moving a sub between groups already updates its kind to match.
function buildSection(categories, kind, signedByCategory, uncategorized) {
  // Income keeps the register's sign (money in is positive); spending flips
  // it, so money out shows as a positive amount spent.
  const flip = kind === 'income' ? 1 : -1;

  const groups = categories
    .filter((c) => c.parent_id === null && c.kind === kind)
    .map((group) => {
      const subs = categories
        .filter((c) => c.parent_id === group.id)
        .map((sub) => ({
          id: sub.id,
          name: sub.name,
          isHidden: Boolean(sub.is_hidden || group.is_hidden),
          actualCents: flip * (signedByCategory.get(sub.id) ?? 0),
        }))
        // A hidden category is retired: show it only when it has money
        // this month, so the totals still add up.
        .filter((sub) => !sub.isHidden || sub.actualCents !== 0);
      const actualCents = subs.reduce((sum, sub) => sum + sub.actualCents, 0);
      return { id: group.id, name: group.name, actualCents, subs };
    })
    .filter((group) => group.subs.length > 0);

  const totalCents = groups.reduce((sum, g) => sum + g.actualCents, 0) + uncategorized.cents;
  return { groups, uncategorized, totalCents };
}
