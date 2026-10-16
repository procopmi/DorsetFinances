// Converting between what people type/read ("1,234.56") and what we store
// (123456 cents).
//
// Why cents: computers store decimals like 0.10 approximately, so adding money
// as decimals slowly drifts (0.1 + 0.2 = 0.30000000000000004). Whole numbers are
// exact, so every amount in the app is an integer count of cents, and dollars
// exist only at the moment of typing or displaying.

// Accepts: "12", "12.3", "12.34", ".50", "1,234.56", "$1,234.56", "-12.34", "-$5".
// Commas must be in the right places, and at most two digits after the point.
// The text is never turned into a decimal number; the dollars and cents parts
// are read as separate whole numbers, so there's no rounding anywhere.
const AMOUNT_PATTERN = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{1,2}))?$/;

// Turns typed text into integer cents. Throws an Error with a readable message
// if the text isn't a valid amount, so the UI can show it to the user.
export function parseDollarsToCents(text) {
  const trimmed = String(text).trim();
  const match = AMOUNT_PATTERN.exec(trimmed);

  // The pattern allows an empty dollars part (for ".50"), so also require that
  // at least one digit was typed somewhere.
  if (!match || !/\d/.test(trimmed)) {
    throw new Error(`"${text}" is not a valid amount`);
  }

  const [, minus, dollarsText, centsText = ''] = match;
  const dollars = Number(dollarsText.replaceAll(',', '') || '0');
  // "12.3" means 30 cents, not 3, so pad a single digit on the right.
  const cents = Number(centsText.padEnd(2, '0'));
  const total = dollars * 100 + cents;

  // Guard against amounts so large that JavaScript can't count them exactly.
  if (!Number.isSafeInteger(total)) {
    throw new Error(`"${text}" is too large`);
  }

  // "-0" would be odd to store, so a zero is always a plain 0.
  return minus && total !== 0 ? -total : total;
}

// Turns integer cents into display text: 123456 -> "1,234.56", -5 -> "-0.05".
// No dollar sign, because register columns are already understood as dollars.
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`formatCents expects whole cents, got ${cents}`);
  }

  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  // Splitting with whole-number division keeps this exact.
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;

  return `${sign}${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
}

// The balance after each transaction, like the last column of a paper register.
// Pass the opening balance and the signed amounts already in register order
// (oldest first); you get back one balance per amount, in the same order.
//   runningBalances(1000, [-250, 500]) -> [750, 1250]
// Balances are always computed like this, never stored, so editing or deleting
// a transaction can't leave a stale balance behind.
export function runningBalances(openingCents, amountsCents) {
  if (!Number.isSafeInteger(openingCents)) {
    throw new Error(`runningBalances expects whole cents, got ${openingCents}`);
  }

  let balance = openingCents;
  return amountsCents.map((amount) => {
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`runningBalances expects whole cents, got ${amount}`);
    }
    balance += amount;
    return balance;
  });
}
