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

// Called by main.js whenever this screen is shown.
export async function show() {
  const [payeeList, categoryList] = await Promise.all([
    getJson('/api/payees/all'),
    getJson('/api/categories'),
  ]);
  payees = payeeList;
  categoryChoices = buildCategoryChoices(categoryList);

  // Suggestions for the "Merge into" box: every payee name.
  const options = payees.map((p) => new Option(p.name));
  byId('merge-payee-options').replaceChildren(...options);

  render();
}

function render() {
  const rows = payees.map(buildRow);
  byId('payee-rows').replaceChildren(...rows);
  byId('no-payees').hidden = payees.length > 0;
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

  const actionsCell = document.createElement('td');
  actionsCell.className = 'payee-actions';
  showActions(actionsCell, payee);

  row.append(nameCell, categoryCell, usesCell, actionsCell);
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
