// Date ranges for reports: the preset buttons (This month, Year to date, ...)
// and a month's first and last day.
//
// Shared with the browser (like money.js), so the page and the tests use
// exactly the same date math.
//
// Dates are 'YYYY-MM-DD' text and months 'YYYY-MM' text throughout, as in the
// database. Ranges include both ends: { from: '2026-01-01', to: '2026-01-31' }.

const pad = (n) => String(n).padStart(2, '0');

// Day count of a month (monthNumber 1-12), leap years included. Day 0 of the
// next month is the last day of this one; UTC avoids daylight-saving surprises.
function daysInMonth(year, monthNumber) {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

// 'YYYY-MM' -> { from: first day, to: last day }.
export function monthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(year, monthNumber))}` };
}

// 'YYYY-MM' moved by a number of months: shiftMonth('2026-01', -1) -> '2025-12'.
function shiftMonth(month, count) {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + count; // months since year 0
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

// Today in local time, as 'YYYY-MM-DD'.
export function todayText(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The preset buttons. today is 'YYYY-MM-DD' (passed in so tests can fix it).
//   this-month: the whole current month (so a check you've post-dated
//               for later this month is included);
//   last-month: the whole previous month;
//   ytd:        1 January to today;
//   last-12:    the 12 whole months ending with this one;
//   last-year:  1 January to 31 December of last year.
export const PRESETS = ['this-month', 'last-month', 'ytd', 'last-12', 'last-year'];

export function presetRange(preset, today) {
  const month = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  switch (preset) {
    case 'this-month':
      return monthRange(month);
    case 'last-month':
      return monthRange(shiftMonth(month, -1));
    case 'ytd':
      return { from: `${year}-01-01`, to: today };
    case 'last-12':
      return { from: monthRange(shiftMonth(month, -11)).from, to: monthRange(month).to };
    case 'last-year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default:
      throw new Error(`Unknown period "${preset}"`);
  }
}
