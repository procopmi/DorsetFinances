// Tests for payee rules (bank description -> payee). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, ruleMatches, suggestPattern, categoryForAmount } from '../src/rules.js';

const rule = (match_type, pattern, payee_name) => ({ match_type, pattern, payee_name });

test('a contains rule matches anywhere, ignoring capitals', () => {
  const rules = [rule('contains', 'wegmans', 'Wegmans')];
  assert.equal(matchRule('WEGMANS #93 MANALAPAN NJ', rules).payee_name, 'Wegmans');
  assert.equal(matchRule('POS WEGMANS 0093', rules).payee_name, 'Wegmans');
  assert.equal(matchRule('SHOPRITE #12', rules), null);
});

test('starts-with and exact rules only match their way', () => {
  const rules = [rule('starts_with', 'CHECK', 'Checks'), rule('exact', 'Interest', 'Bank interest')];
  assert.equal(matchRule('CHECK 1004', rules).payee_name, 'Checks');
  assert.equal(matchRule('PAYCHECK ACME', rules), null);
  assert.equal(matchRule('interest', rules).payee_name, 'Bank interest');
  assert.equal(matchRule('Interest Charge', rules), null);
});

test('the most specific rule wins', () => {
  const rules = [
    rule('contains', 'WEGMANS', 'Wegmans'),
    rule('contains', 'WEGMANS GAS', 'Wegmans Gas'),
    rule('starts_with', 'WEG', 'Starts'),
  ];
  // "starts with" beats "contains", even with a shorter pattern...
  assert.equal(matchRule('WEGMANS GAS #4', rules).payee_name, 'Starts');
  // ...and among "contains" rules, the longer pattern wins.
  const containsOnly = rules.slice(0, 2);
  assert.equal(matchRule('WEGMANS GAS #4', containsOnly).payee_name, 'Wegmans Gas');
  assert.equal(matchRule('WEGMANS #93', containsOnly).payee_name, 'Wegmans');
});

test('an empty pattern never matches', () => {
  assert.equal(matchRule('Anything', [rule('contains', '  ', 'Nobody')]), null);
});

test('suggested patterns drop store numbers and towns', () => {
  assert.equal(suggestPattern('WEGMANS #93 MANALAPAN NJ'), 'WEGMANS');
  assert.equal(suggestPattern('SHELL OIL 57444 FREEHOLD'), 'SHELL OIL');
  assert.equal(suggestPattern('Payment Thank You'), 'Payment Thank You');
  assert.equal(suggestPattern('AMAZON MKTPL  ORDER  LONG TEXT'), 'AMAZON MKTPL ORDER');
  // Too little left after cutting: use the whole description.
  assert.equal(suggestPattern('#12 MAIN'), '#12 MAIN');
});

test('each bank text counts only for the rule that would pick it', () => {
  const rules = [
    { id: 1, match_type: 'contains', pattern: 'WEGMANS' },
    { id: 2, match_type: 'contains', pattern: 'WEGMANS GAS' },
    { id: 3, match_type: 'exact', pattern: 'Never seen' },
  ];
  const descriptions = [
    { bank_description: 'WEGMANS #93', count: 5 },
    { bank_description: 'WEGMANS GAS #4', count: 2 },
    { bank_description: 'SHOPRITE #12', count: 7 },
  ];
  const matches = ruleMatches(rules, descriptions);
  // "WEGMANS GAS #4" goes to the longer rule only, not to both.
  assert.deepEqual(matches.get(1).map((d) => d.bank_description), ['WEGMANS #93']);
  assert.deepEqual(matches.get(2).map((d) => d.bank_description), ['WEGMANS GAS #4']);
  assert.deepEqual(matches.get(3), []);
});

test('an amount rule picks the category by the size of the amount', () => {
  const lifeCo = { threshold_cents: 10000, below_category_id: 'Cindy', otherwise_category_id: 'Michael' };
  assert.equal(categoryForAmount(lifeCo, -8000), 'Cindy');
  assert.equal(categoryForAmount(lifeCo, -9999), 'Cindy');     // $99.99 is under $100.00
  assert.equal(categoryForAmount(lifeCo, -10000), 'Michael');  // $100.00 is not under
  assert.equal(categoryForAmount(lifeCo, -14000), 'Michael');
  assert.equal(categoryForAmount(lifeCo, 8000), 'Cindy');      // a refund goes back to the same policy
});
