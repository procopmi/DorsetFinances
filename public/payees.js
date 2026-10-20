// The Payees screen: every payee with its default category and how often it's
// used, plus rename, hide, merge and import rules.
//
// Merge is the important one: manual entry and CSV imports tend to create
// near-duplicates ("Corner Mkt" vs "Corner Market"), and merging folds one
// into the other, moving all its transactions. Tick several payees to merge
// them all at once, e.g. the raw bank names a big import leaves behind.

import { byId, getJson, postJson, runAction, makeButton } from '/api.js';
import { buildCategoryChoices } from '/register.js';
import { parseDollarsToCents, formatCents } from '/money.js';

let payees = [];          // every payee, hidden ones too, with use_count
let categoryChoices = []; // "Group: Sub" choices for the default-category dropdown
let rules = [];           // import rules (bank text -> payee), shown with their payee

let openMatchesRuleId = null; // the rule whose matched bank text is listed, if any
const ticked = new Set();     // ids of payees ticked for merging; kept while you filter

// The filter box narrows the list as you type. Its text survives show(), so
// the list stays filtered after you edit something.
byId('payee-filter').addEventListener('input', render);

byId('tick-all-shown').addEventListener('change', (event) => {
  for (const p of shownPayees()) {
    if (event.target.checked) ticked.add(p.id);
    else ticked.delete(p.id);
  }
  render();
});

// Called by main.js whenever this screen is shown.
export async function show() {
  const [payeeList, categoryList, ruleList] = await Promise.all([
    getJson('/api/payees/all'),
    getJson('/api/categories'),
    getJson('/api/payee-rules'),
  ]);
  payees = payeeList;
  categoryChoices = buildCategoryChoices(categoryList);
  rules = ruleList;

  // Suggestions for the "Merge into" box: every payee name.
  const options = payees.map((p) => new Option(p.name));
  byId('merge-payee-options').replaceChildren(...options);

  // Forget ticks on payees that no longer exist (merged away).
  for (const id of ticked) {
    if (!payees.some((p) => p.id === id)) ticked.delete(id);
  }
  render();
}

// A payee is shown if the filter text is in its name or in one of its rules.
function shownPayees() {
  const filter = byId('payee-filter').value.trim().toLowerCase();
  return payees.filter(
    (p) =>
      p.name.toLowerCase().includes(filter) ||
      rulesFor(p).some((r) => r.pattern.toLowerCase().includes(filter))
  );
}

function render() {
  const shown = shownPayees();
  byId('payee-rows').replaceChildren(...shown.flatMap(buildRows));
  byId('no-payees').hidden = payees.length > 0;
  updateMergeBar(shown);
}

const rulesFor = (payee) => rules.filter((r) => r.payee_id === payee.id);

// The payee's row, plus a second row listing a rule's matches if it's open.
function buildRows(payee) {
  const rows = [buildRow(payee)];
  const openRule = rulesFor(payee).find((r) => r.id === openMatchesRuleId);
  if (openRule) rows.push(buildMatchesRow(openRule));
  return rows;
}

function buildRow(payee) {
  const row = document.createElement('tr');

  const tickCell = document.createElement('td');
  const tick = document.createElement('input');
  tick.type = 'checkbox';
  tick.checked = ticked.has(payee.id);
  tick.title = 'Tick to merge with others';
  tick.addEventListener('change', () => {
    if (tick.checked) ticked.add(payee.id);
    else ticked.delete(payee.id);
    updateMergeBar(shownPayees());
  });
  tickCell.append(tick);

  const nameCell = document.createElement('td');
  nameCell.textContent = payee.is_hidden ? `${payee.name} (hidden)` : payee.name;
  nameCell.classList.toggle('muted', Boolean(payee.is_hidden));

  const categoryCell = document.createElement('td');
  categoryCell.append(buildCategorySelect(payee), buildAmountRule(payee));

  const usesCell = document.createElement('td');
  usesCell.className = 'col-money';
  usesCell.textContent = payee.use_count;

  const rulesCell = document.createElement('td');
  const blankRule = { id: null, match_type: 'contains', pattern: '', payee_name: payee.name };
  const addButton = makeButton('+ rule', async () => addButton.replaceWith(buildRuleForm(blankRule, addButton)), 'rule-add');
  rulesCell.append(...rulesFor(payee).map(buildRuleChip), addButton);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'payee-actions';
  showActions(actionsCell, payee);

  row.append(tickCell, nameCell, categoryCell, usesCell, rulesCell, actionsCell);
  return row;
}

// One import rule, e.g. [contains "WEGMANS" · 42 rows ✎ ✕].
//   - The row count is how many imported rows this rule would pick; click it
//     to list their bank text below the payee.
//   - ✎ edits the rule in place.
//   - ✕ deletes it, after asking.
// Changing or deleting a rule changes no transactions; only future imports.
// RULE_WORDS is also used by the import preview to describe the rule that matched.
export const RULE_WORDS ={ contains: 'contains', starts_with: 'starts with', exact: 'is exactly' };

function buildRuleChip(rule) {
  const chip = document.createElement('span');
  chip.className = 'tag rule-chip';
  chip.textContent = `${RULE_WORDS[rule.match_type]} "${rule.pattern}" · `;
  chip.append(
    makeButton(`${rule.match_count} row(s)`, async () => {
      openMatchesRuleId = openMatchesRuleId === rule.id ? null : rule.id;
      render();
    }, 'rule-count'),
    makeButton('✎', async () => chip.replaceWith(buildRuleForm(rule, chip)), 'rule-delete'),
    makeButton('✕', async () => {
      if (!confirm(`Stop turning bank text that ${RULE_WORDS[rule.match_type]} "${rule.pattern}" into "${rule.payee_name}"?`)) return;
      await postJson('/api/payee-rules/delete', { id: rule.id });
      await show();
    }, 'rule-delete')
  );
  return chip;
}

// The form for adding or changing a rule: kind, text, and the payee it
// produces (so a rule can be pointed at a different payee). It takes the
// place of `original` (the chip, or the "+ rule" button) until saved or
// cancelled. Enter saves, Esc cancels.
function buildRuleForm(rule, original) {
  const form = document.createElement('span');
  form.className = 'rule-form';

  const kind = document.createElement('select');
  for (const [value, words] of Object.entries(RULE_WORDS)) kind.append(new Option(words, value));
  kind.value = rule.match_type;

  const pattern = document.createElement('input');
  pattern.value = rule.pattern;
  pattern.placeholder = 'bank text';

  const payee = document.createElement('input');
  payee.setAttribute('list', 'merge-payee-options');
  payee.value = rule.payee_name;
  payee.autocomplete = 'off';

  const save = () =>
    runAction(async () => {
      const fields = { matchType: kind.value, pattern: pattern.value, payeeName: payee.value };
      if (rule.id === null) await postJson('/api/payee-rules/add', fields);
      else await postJson('/api/payee-rules/update', { id: rule.id, ...fields });
      await show();
    });
  const cancel = () => form.replaceWith(original);

  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      cancel();
    }
  });

  form.append(kind, pattern, ' → ', payee, makeButton('Save', async () => save()), makeButton('Cancel', async () => cancel()));
  setTimeout(() => pattern.focus()); // once the form is on the page
  return form;
}

// The bank text a rule picks from imported rows, shown under its payee:
// each distinct text, how many rows have it, and the payee they got. A rule
// that's too broad shows up here as text that doesn't belong.
function buildMatchesRow(rule) {
  const row = document.createElement('tr');
  row.className = 'rule-matches';
  const cell = document.createElement('td');
  cell.colSpan = 6;
  row.append(cell);

  cell.textContent = 'Loading…';
  runAction(async () => {
    const matches = await getJson(`/api/payee-rules/matches?id=${rule.id}`);
    if (matches.length === 0) {
      cell.textContent = `No imported rows are picked by ${RULE_WORDS[rule.match_type]} "${rule.pattern}".`;
      return;
    }
    const list = document.createElement('ul');
    for (const m of matches) {
      const item = document.createElement('li');
      item.textContent = `${m.bank_description} · ${m.count} row(s) · now: ${m.payees ?? '(no payee)'}`;
      list.append(item);
    }
    cell.replaceChildren(`${RULE_WORDS[rule.match_type]} "${rule.pattern}" picks:`, list);
  });
  return row;
}

// The normal buttons for a row.
function showActions(cell, payee) {
  cell.replaceChildren(
    makeButton('Rename', () => rename(payee)),
    makeButton(payee.is_hidden ? 'Unhide' : 'Hide', () => setHidden(payee)),
    makeButton('Merge into…', async () => showMergeBox(cell, payee))
  );
}

// A category dropdown, grouped by category group, with `currentId` chosen.
// A hidden category is still listed if it's the current one, so the
// dropdown always shows the truth.
function categorySelect(currentId) {
  const select = document.createElement('select');
  select.append(new Option('(none)', ''));

  const groups = new Map();
  for (const choice of categoryChoices) {
    if (choice.isHidden && choice.id !== currentId) continue;
    if (!groups.has(choice.groupName)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = choice.groupName;
      groups.set(choice.groupName, optgroup);
      select.append(optgroup);
    }
    groups.get(choice.groupName).append(new Option(choice.subName, choice.id));
  }
  select.value = currentId ?? '';
  return select;
}

// The default-category dropdown. Changing it saves straight away.
function buildCategorySelect(payee) {
  const select = categorySelect(payee.default_category_id);

  select.addEventListener('change', () =>
    runAction(async () => {
      await postJson('/api/payees/set-default-category', {
        id: payee.id,
        categoryId: select.value === '' ? null : Number(select.value),
      });
      await show();
    })
  );
  return select;
}

// --- Amount rules ---
//
// For a payee whose bank text never changes but whose payments belong to two
// categories, told apart by size (two life insurance policies from one
// insurer, say): "under $100.00 → Life - Cindy, otherwise → Life - Michael".
// Imports use it to choose the category; it overrides the default category.
// The size of the amount is compared, so a refund goes to the same category.

const subName = (id) => categoryChoices.find((c) => c.id === id)?.subName ?? '?';

// The rule as a line under the default category, with ✎ and ✕; or, if the
// payee has none, a "+ amount rule" button.
function buildAmountRule(payee) {
  const line = document.createElement('div');
  line.className = 'amount-rule';

  if (payee.threshold_cents === null) {
    line.append(makeButton('+ amount rule', async () => line.replaceWith(buildAmountRuleForm(payee, line)), 'rule-add'));
    return line;
  }

  line.textContent =
    `Under $${formatCents(payee.threshold_cents)} → ${subName(payee.below_category_id)}, ` +
    `otherwise → ${subName(payee.otherwise_category_id)} `;
  line.append(
    makeButton('✎', async () => line.replaceWith(buildAmountRuleForm(payee, line)), 'rule-delete'),
    makeButton('✕', async () => {
      if (!confirm(`Remove the amount rule from "${payee.name}"? Imports will use its default category instead.`)) return;
      await postJson('/api/payees/delete-amount-rule', { payeeId: payee.id });
      await show();
    }, 'rule-delete')
  );
  return line;
}

// "Under $[ ] → [category] otherwise → [category] Save Cancel", in place of
// `original` until saved or cancelled. Enter saves, Esc cancels.
function buildAmountRuleForm(payee, original) {
  const form = document.createElement('div');
  form.className = 'amount-rule rule-form';

  const threshold = document.createElement('input');
  threshold.className = 'amount-input';
  threshold.placeholder = '100.00';
  if (payee.threshold_cents !== null) threshold.value = formatCents(payee.threshold_cents);
  const below = categorySelect(payee.below_category_id);
  const otherwise = categorySelect(payee.otherwise_category_id);

  const save = () =>
    runAction(async () => {
      // Dollars typed here become whole cents (money.js); never a decimal number.
      await postJson('/api/payees/set-amount-rule', {
        payeeId: payee.id,
        thresholdCents: parseDollarsToCents(threshold.value),
        belowCategoryId: below.value === '' ? null : Number(below.value),
        otherwiseCategoryId: otherwise.value === '' ? null : Number(otherwise.value),
      });
      await show();
    });
  const cancel = () => form.replaceWith(original);

  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      cancel();
    }
  });

  form.append('Under $', threshold, ' → ', below, ' otherwise → ', otherwise,
    makeButton('Save', async () => save()), makeButton('Cancel', async () => cancel()));
  setTimeout(() => threshold.focus()); // once the form is on the page
  return form;
}

// --- Actions ---

async function rename(payee) {
  const name = prompt(`New name for "${payee.name}":`, payee.name);
  if (name === null || name.trim() === '') return; // cancelled or left blank
  await postJson('/api/payees/rename', { id: payee.id, name });
  await show();
}

// Hidden payees stop appearing as suggestions in the register but stay on
// their transactions. No confirmation: Unhide reverses it.
async function setHidden(payee) {
  await postJson('/api/payees/set-hidden', { id: payee.id, isHidden: !payee.is_hidden });
  await show();
}

// Swaps the row's buttons for a "merge into" box: type the payee to keep
// (with suggestions), then Enter or Merge. Esc or Cancel puts the buttons back.
function showMergeBox(cell, payee) {
  const input = document.createElement('input');
  input.setAttribute('list', 'merge-payee-options');
  input.placeholder = 'Payee to keep';
  input.autocomplete = 'off';
  const { label: rememberLabel, box: remember } = rememberBox();

  const merge = () => runAction(() => mergeInto([payee], input.value, remember.checked));
  const cancel = () => showActions(cell, payee);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      merge();
    } else if (event.key === 'Escape') {
      cancel();
    }
  });

  cell.replaceChildren(
    input,
    rememberLabel,
    makeButton('Merge', async () => merge(), 'danger'),
    makeButton('Cancel', async () => cancel())
  );
  input.focus();
}

// The "Remember these names" tickbox, on by default. A payee made from raw
// bank text ("CORNER MKT #12 FREEHOLD") would otherwise be created again by
// the next import that has that text; with this ticked, its name becomes an
// "is exactly" rule pointing at the payee you keep.
function rememberBox() {
  const label = document.createElement('label');
  label.className = 'remember-names';
  label.title = 'Each merged name becomes an "is exactly" import rule for the payee you keep';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = true;
  label.append(box, ' Remember names for imports');
  return { label, box };
}

// Merges one or more payees into the one named `typedName`. Permanent, so
// it spells out what will happen and asks first.
async function mergeInto(fromPayees, typedName, rememberNames) {
  const wanted = typedName.trim().toLowerCase();
  const into = payees.find((p) => p.name.toLowerCase() === wanted);
  if (!into) {
    alert(`There's no payee named "${typedName.trim()}". Pick one from the suggestions.`);
    return;
  }
  // Ticking the payee you're keeping is an easy slip; leave it out rather
  // than refuse, since "merge these into one of them" is what was meant.
  const from = fromPayees.filter((p) => p.id !== into.id);
  if (from.length === 0) {
    alert('Choose a different payee to merge into.');
    return;
  }

  // List the names, but not hundreds of them: the box would run off the screen.
  const shownNames = from.slice(0, 15).map((p) => `  ${p.name}`);
  if (from.length > 15) shownNames.push(`  …and ${from.length - 15} more`);
  const transactions = from.reduce((sum, p) => sum + p.use_count, 0);

  // A payee has at most one amount rule. The kept payee keeps its own, or
  // takes the first merged one's if it has none; any others are removed
  // (db.js mergePayees does the same).
  const withAmountRule = from.filter((p) => p.threshold_cents !== null);
  const movingRule = into.threshold_cents === null ? withAmountRule[0] : undefined;
  const droppedRules = withAmountRule.filter((p) => p !== movingRule);
  let amountRuleText = '';
  if (movingRule) amountRuleText += `\nThe amount rule on "${movingRule.name}" will move to "${into.name}".`;
  if (droppedRules.length) {
    amountRuleText += `\nThe amount rule on ${droppedRules.map((p) => `"${p.name}"`).join(', ')} will be removed.`;
  }

  const message =
    `Merge ${from.length} payee(s) into "${into.name}"?\n\n${shownNames.join('\n')}\n\n` +
    `${transactions} transaction(s) will move to "${into.name}", and these payees will be deleted.` +
    (rememberNames
      ? `\nEach name will be remembered as an import rule for "${into.name}".`
      : '\nNo import rules will be added for these names.') +
    amountRuleText +
    '\n\nThis cannot be undone.';
  if (!confirm(message)) return;

  await postJson('/api/payees/merge', {
    fromIds: from.map((p) => p.id),
    intoId: into.id,
    rememberNames,
  });
  for (const p of from) ticked.delete(p.id);
  await show();
}

// --- Merging the ticked payees (the bar above the table) ---

const mergeTarget = byId('merge-ticked-into');
const { label: tickedRememberLabel, box: tickedRemember } = rememberBox();
byId('merge-ticked-remember').replaceWith(tickedRememberLabel);

function mergeTicked() {
  runAction(() =>
    mergeInto(
      payees.filter((p) => ticked.has(p.id)),
      mergeTarget.value,
      tickedRemember.checked
    )
  );
}

byId('merge-ticked').addEventListener('click', mergeTicked);
mergeTarget.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    mergeTicked();
  }
});
byId('clear-ticked').addEventListener('click', () => {
  ticked.clear();
  render();
});

// Shows the bar while anything is ticked, with how many (and how many of
// those the filter is currently hiding, so a merge holds no surprises).
function updateMergeBar(shown) {
  const shownIds = new Set(shown.map((p) => p.id));
  const hiddenCount = [...ticked].filter((id) => !shownIds.has(id)).length;
  byId('merge-bar').hidden = ticked.size === 0;
  byId('merge-ticked-count').textContent =
    `${ticked.size} ticked` + (hiddenCount ? ` (${hiddenCount} hidden by the filter)` : '');

  // The header box ticks or unticks every payee the filter is showing.
  const all = byId('tick-all-shown');
  const tickedShown = shown.filter((p) => ticked.has(p.id)).length;
  all.checked = shown.length > 0 && tickedShown === shown.length;
  all.indeterminate = tickedShown > 0 && tickedShown < shown.length;
}

// --- Applying rules to rows already imported ---
//
// Rows imported before your rules were set up stay uncategorized, and
// re-importing the bank file won't help: the import skips every row it has
// seen before. This runs today's rules on the bank text saved with each
// imported row instead. Only rows with no category are offered, so nothing
// you categorized yourself is touched. The server makes a backup first.

let reapplyRows = []; // one entry per preview row: the server's row and its tickbox

const categoryText = (id) => categoryChoices.find((c) => c.id === id)?.label ?? '';
const STATUS_MARKS = { uncleared: '', cleared: 'c', reconciled: 'R' }; // as in the register

byId('show-reapply').addEventListener('click', () => runAction(showReapply));
byId('cancel-reapply').addEventListener('click', () => {
  byId('reapply-panel').hidden = true;
});
byId('commit-reapply').addEventListener('click', () => runAction(commitReapply));
byId('reapply-tick-all').addEventListener('change', (event) => {
  for (const r of reapplyRows) r.box.checked = event.target.checked;
  updateReapply();
});

async function showReapply() {
  const preview = await getJson('/api/reapply-rules/preview');
  const parts = [`${preview.rows.length} uncategorized imported row(s) can be filled in by your rules`];
  if (preview.unchanged) parts.push(`${preview.unchanged} more have no rule or usual category yet`);
  byId('reapply-summary').textContent =
    `${parts.join('; ')}. Untick any you want to leave as they are.`;

  reapplyRows = preview.rows.map(buildReapplyRow);
  byId('reapply-rows').replaceChildren(...reapplyRows.map((r) => r.tr));
  updateReapply();
  byId('reapply-panel').hidden = false;
}

function buildReapplyRow(row) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = true;
  box.addEventListener('change', updateReapply);

  const cell = (text, className) => {
    const td = document.createElement('td');
    td.textContent = text ?? '';
    if (className) td.className = className;
    return td;
  };

  // "old → new" when the rule changes the payee, else just the payee.
  const payeeText = row.newPayeeId === row.payee_id ? row.newPayee : `${row.payee ?? '(none)'} → ${row.newPayee}`;
  const payeeCell = cell(payeeText, 'col-payee');
  if (row.rule) payeeCell.title = `Import rule: ${RULE_WORDS[row.rule.matchType]} "${row.rule.pattern}"`;

  const tr = document.createElement('tr');
  const tickCell = cell('', 'col-clr');
  tickCell.append(box);
  tr.append(
    tickCell,
    cell(row.date, 'col-date'),
    cell(row.account),
    cell(row.bank_description),
    payeeCell,
    cell(categoryText(row.newCategoryId) || '(stays uncategorized)', 'col-category'),
    cell(formatCents(row.amount_cents), 'col-money'),
    cell(STATUS_MARKS[row.status], 'col-clr')
  );
  return { row, box, tr };
}

// Greys out unticked rows and keeps the button and header box in step.
function updateReapply() {
  const tickedCount = reapplyRows.filter((r) => r.box.checked).length;
  for (const r of reapplyRows) r.tr.classList.toggle('skipped', !r.box.checked);

  const button = byId('commit-reapply');
  button.textContent = `Update ${tickedCount} row(s)`;
  button.disabled = tickedCount === 0;

  const all = byId('reapply-tick-all');
  all.checked = reapplyRows.length > 0 && tickedCount === reapplyRows.length;
  all.indeterminate = tickedCount > 0 && tickedCount < reapplyRows.length;
}

async function commitReapply() {
  const ticked = reapplyRows.filter((r) => r.box.checked);
  const reconciled = ticked.filter((r) => r.row.status === 'reconciled').length;
  const message =
    `Set the payee and category on ${ticked.length} row(s)?` +
    (reconciled ? `\n\n${reconciled} of them are reconciled (R).` : '') +
    '\n\nA backup is made first.';
  if (!confirm(message)) return;

  const result = await postJson('/api/reapply-rules/commit', { ids: ticked.map((r) => r.row.id) });
  byId('reapply-panel').hidden = true;
  alert(
    `Updated ${result.updated} row(s).` +
      (result.skipped ? ` ${result.skipped} skipped (changed since the preview).` : '') +
      (result.backupFile ? `\n\nBackup saved to ${result.backupFile}` : '')
  );
  await show(); // payee use counts have changed
}
