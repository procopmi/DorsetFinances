// The Reports screen's arithmetic. Plain functions with no SQL, so the tests
// can check the math directly.
//
// Counting rules are the Budget screen's (both start from sumActuals in
// budget.js): every account, transfers left out, spending shown as a positive
// amount with refunds lowering their category, and uncategorized money shown
// as its own line.

import { sumActuals } from './budget.js';

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
  const { signedByCategory, uncategorizedOut } = sumActuals(actualRows);

  const groups = categories
    .filter((c) => c.parent_id === null && c.kind === 'expense')
    .map((group) => {
      const subs = categories
        .filter((c) => c.parent_id === group.id)
        // Money out is negative in the register; flip it so spending is positive.
        .map((sub) => ({
          id: sub.id,
          name: sub.name,
          isHidden: Boolean(sub.is_hidden || group.is_hidden),
          cents: -(signedByCategory.get(sub.id) ?? 0),
        }))
        .filter((sub) => sub.cents !== 0)
        .sort((a, b) => b.cents - a.cents);
      return { id: group.id, name: group.name, cents: subs.reduce((sum, sub) => sum + sub.cents, 0), subs };
    })
    .filter((group) => group.subs.length > 0)
    .sort((a, b) => b.cents - a.cents);

  const totalCents = groups.reduce((sum, g) => sum + g.cents, 0) + uncategorizedOut.cents;

  // Share of all spending, as a whole percent. This is for display only (the
  // amounts themselves stay in exact cents), so ordinary division is fine.
  // Shares can add up to 99 or 101 because of rounding.
  const share = (cents) => (totalCents > 0 ? Math.round((cents * 100) / totalCents) : 0);
  for (const group of groups) {
    group.sharePercent = share(group.cents);
    for (const sub of group.subs) sub.sharePercent = share(sub.cents);
  }

  return {
    groups,
    uncategorized: { ...uncategorizedOut, sharePercent: share(uncategorizedOut.cents) },
    totalCents,
  };
}
