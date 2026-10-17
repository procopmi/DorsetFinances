// Tests for payee rules (bank description -> payee). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, suggestPattern } from '../src/rules.js';

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
