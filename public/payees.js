// The Payees screen: every payee with its default category and how often it's
// used, plus rename, hide and merge.
//
// Merge is the important one: manual entry and CSV imports tend to create
// near-duplicates ("Corner Mkt" vs "Corner Market"), and merging folds one
// into the other, moving all its transactions.

import { byId, getJson, postJson, runAction, makeButton } from '/api.js';
import { buildCategoryChoices } from '/register.js';

let payees = [];          // every payee, hidden ones too, with use_count
let categoryChoices = []; // "Group: Sub" choices for the default-category dropdown
let rules = [];           // import rules (bank text -> payee), shown with their payee

let openMatchesRuleId = null; // the rule whose matched bank text is listed, if any

// The filter box narrows the list as you type. Its text survives show(), so
// the list stays filtered after you edit something.
byId('payee-filter').addEventListener('input', render);

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

  render();
}

// A payee is shown if the filter text is in its name or in one of its rules.
function render() {
  const filter = byId('payee-filter').value.trim().toLowerCase();
  const shown = payees.filter(
    (p) =>
      p.name.toLowerCase().includes(filter) ||
      rulesFor(p).some((r) => r.pattern.toLowerCase().includes(filter))
  );
  byId('payee-rows').replaceChildren(...shown.flatMap(buildRows));
  byId('no-payees').hidden = payees.length > 0;
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

  const nameCell = document.createElement('td');
  nameCell.textContent = payee.is_hidden ? `${payee.name} (hidden)` : payee.name;
  nameCell.classList.toggle('muted', Boolean(payee.is_hidden));

  const categoryCell = document.createElement('td');
  categoryCell.append(buildCategorySelect(payee));

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

  row.append(nameCell, categoryCell, usesCell, rulesCell, actionsCell);
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
  cell.colSpan = 5;
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

// The default-category dropdown, grouped by category group. Changing it saves
// straight away. A hidden category is still listed if it's this payee's
// current default, so the dropdown always shows the truth.
function buildCategorySelect(payee) {
  const select = document.createElement('select');
  select.append(new Option('(none)', ''));

  const groups = new Map();
  for (const choice of categoryChoices) {
    if (choice.isHidden && choice.id !== payee.default_category_id) continue;
    if (!groups.has(choice.groupName)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = choice.groupName;
      groups.set(choice.groupName, optgroup);
      select.append(optgroup);
    }
    groups.get(choice.groupName).append(new Option(choice.subName, choice.id));
  }
  select.value = payee.default_category_id ?? '';

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

  const merge = () => runAction(() => mergeInto(payee, input.value));
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
    makeButton('Merge', async () => merge(), 'danger'),
    makeButton('Cancel', async () => cancel())
  );
  input.focus();
}

// Permanent, so it spells out what will happen and asks first.
async function mergeInto(from, typedName) {
  const wanted = typedName.trim().toLowerCase();
  const into = payees.find((p) => p.name.toLowerCase() === wanted);
  if (!into) {
    alert(`There's no payee named "${typedName.trim()}". Pick one from the suggestions.`);
    return;
  }
  if (into.id === from.id) {
    alert('Choose a different payee to merge into.');
    return;
  }

  const message =
    `Merge "${from.name}" into "${into.name}"?\n\n` +
    `${from.use_count} transaction(s) will move to "${into.name}", ` +
    `and "${from.name}" will be deleted.\n\nThis cannot be undone.`;
  if (!confirm(message)) return;

  await postJson('/api/payees/merge', { fromId: from.id, intoId: into.id });
  await show();
}
