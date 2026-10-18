// Payee rules: turning a bank's description ("WEGMANS #93 MANALAPAN NJ")
// into one of your payees ("Wegmans") during an import.
//
// Plain functions with no database code, so the tests can check them directly.

// How strongly each kind of rule matches; a stronger kind wins.
const RULE_STRENGTH = { exact: 3, starts_with: 2, contains: 1 };

// Whether one rule fits a description. Capitals and surrounding spaces are
// ignored, so "wegmans" matches "WEGMANS #93".
function ruleFits(rule, description) {
  const text = description.trim().toLowerCase();
  const pattern = rule.pattern.trim().toLowerCase();
  if (pattern === '') return false;
  if (rule.match_type === 'exact') return text === pattern;
  if (rule.match_type === 'starts_with') return text.startsWith(pattern);
  return text.includes(pattern);
}

// The best rule for a description, or null if none fits. When several fit,
// the most specific wins: exact beats "starts with" beats "contains", and
// then the longer pattern wins (so "WEGMANS GAS" beats "WEGMANS").
export function matchRule(description, rules) {
  let best = null;
  for (const rule of rules) {
    if (!ruleFits(rule, description)) continue;
    const better =
      !best ||
      RULE_STRENGTH[rule.match_type] > RULE_STRENGTH[best.match_type] ||
      (rule.match_type === best.match_type && rule.pattern.trim().length > best.pattern.trim().length);
    if (better) best = rule;
  }
  return best;
}

// Which bank texts each rule would pick, for reviewing rules after an import.
// `descriptions` is a list of { bank_description, count } (imported rows,
// grouped by their bank text). Each text goes to the rule matchRule picks for
// it, so a rule that always loses to a more specific one gets nothing; that
// is worth seeing, because such a rule is doing no work.
// Returns a Map: rule id -> the descriptions that rule picks.
export function ruleMatches(rules, descriptions) {
  const byRule = new Map(rules.map((rule) => [rule.id, []]));
  for (const description of descriptions) {
    const rule = matchRule(description.bank_description, rules);
    if (rule) byRule.get(rule.id).push(description);
  }
  return byRule;
}

// A starting pattern for a new "contains" rule, from a bank description.
// Bank text usually puts the name first, then store numbers and the town:
//   "WEGMANS #93 MANALAPAN NJ"  -> "WEGMANS"
//   "SHELL OIL 57444 FREEHOLD"  -> "SHELL OIL"
//   "Payment Thank You"         -> "Payment Thank You"
// So: cut at the first "#" or long number, keep at most three words. If that
// leaves almost nothing, use the whole description. You can edit it anyway.
export function suggestPattern(description) {
  const whole = description.trim().replace(/\s+/g, ' ');
  const beforeNumbers = whole.split(/#|\d{3,}/)[0].trim();
  const shortened = beforeNumbers.split(' ').slice(0, 3).join(' ');
  return shortened.length >= 3 ? shortened : whole;
}
