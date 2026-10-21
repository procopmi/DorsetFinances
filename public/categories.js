// The Categories screen: every group with its sub-categories, and the
// actions to add, rename, hide, move and delete them.
//
// The server enforces all the rules (unique names, no deleting a category in
// use, ...); this page just asks and then shows the server's answer. Simple
// browser prompts and confirm boxes keep it small, as on the account sidebar.

import { byId, getJson, postJson, runAction, makeButton } from '/api.js';

// The full category list as last loaded from the server (groups and subs).
let categories = [];

// Called by main.js whenever this screen is shown.
export async function show() {
  categories = await getJson('/api/categories');
  render();
}

const groupsOf = () => categories.filter((c) => c.parent_id === null);
const subsOf = (group) => categories.filter((c) => c.parent_id === group.id);

function render() {
  byId('category-groups').replaceChildren(...groupsOf().map(buildGroup));
}

function buildGroup(group) {
  const section = document.createElement('section');
  section.className = 'category-group';

  const header = document.createElement('div');
  header.className = 'category-row group-row';
  header.append(
    nameLabel(group.name, group.is_hidden, 'h3'),
    tag(group.kind === 'income' ? 'Income' : 'Expense'),
    makeButton('Rename', () => rename(group, group.name)),
    makeButton(group.is_hidden ? 'Unhide' : 'Hide', () => setHidden(group)),
    makeButton('+ Add sub', () => addSub(group)),
    makeButton('Delete', () => remove(group, group.name), 'danger')
  );

  const list = document.createElement('ul');
  list.className = 'sub-list';
  list.append(...subsOf(group).map((sub) => buildSub(sub, group)));

  section.append(header, list);
  return section;
}

function buildSub(sub, group) {
  const label = `${group.name}: ${sub.name}`;
  const item = document.createElement('li');
  item.className = 'category-row';
  item.append(
    nameLabel(sub.name, sub.is_hidden || group.is_hidden, 'span'),
    makeButton('Rename', () => rename(sub, label)),
    makeButton(sub.is_hidden ? 'Unhide' : 'Hide', () => setHidden(sub)),
    buildMoveSelect(sub),
    makeButton('Delete', () => remove(sub, label), 'danger')
  );
  return item;
}

// The name, greyed out with "(hidden)" when it's hidden (or its group is).
function nameLabel(name, isHidden, tagName) {
  const element = document.createElement(tagName);
  element.className = 'category-name';
  // textContent (not innerHTML) so a name is always plain text, never HTML.
  element.textContent = isHidden ? `${name} (hidden)` : name;
  element.classList.toggle('muted', Boolean(isHidden));
  return element;
}

function tag(text) {
  const span = document.createElement('span');
  span.className = 'tag';
  span.textContent = text;
  return span;
}

// A "Move to…" dropdown listing the other groups. Choosing one moves the sub
// straight away; moving is easy to undo, so it doesn't ask first.
function buildMoveSelect(sub) {
  const select = document.createElement('select');
  select.className = 'move-select';
  select.append(new Option('Move to…', ''));
  for (const group of groupsOf()) {
    if (group.id !== sub.parent_id) select.append(new Option(group.name, group.id));
  }
  select.addEventListener('change', () =>
    runAction(async () => {
      await postJson('/api/categories/move', { id: sub.id, parentId: Number(select.value) });
      await show();
    })
  );
  return select;
}

// --- Actions ---

async function rename(category, label) {
  const name = prompt(`New name for "${label}":`, category.name);
  if (name === null || name.trim() === '') return; // cancelled or left blank
  await postJson('/api/categories/rename', { id: category.id, name });
  await show();
}

// Hiding drops a category from the register's suggestions but keeps it on
// existing transactions, so it's the safe way to retire one. No confirmation:
// Unhide reverses it.
async function setHidden(category) {
  await postJson('/api/categories/set-hidden', { id: category.id, isHidden: !category.is_hidden });
  await show();
}

async function addSub(group) {
  const name = prompt(`Name of the new sub-category in "${group.name}":`);
  if (name === null || name.trim() === '') return;
  await postJson('/api/categories', { name, parentId: group.id });
  await show();
}

// Permanent, so it always asks. The server refuses if the category is in use
// (or is a group that still has subs) and says why.
async function remove(category, label) {
  const message = `Delete the category "${label}"?\n\nIts planned budget amounts are deleted too. This cannot be undone.`;
  if (!confirm(message)) return;
  await postJson('/api/categories/delete', { id: category.id });
  await show();
}

// --- Adding a group ---

const groupForm = byId('add-group-form');

groupForm.addEventListener('submit', (event) => {
  // Stop the browser's own form submit (a page reload); we send it with fetch.
  event.preventDefault();
  runAction(async () => {
    await postJson('/api/categories', {
      name: groupForm.elements.name.value,
      kind: groupForm.elements.kind.value,
    });
    groupForm.reset();
    await show();
  });
});
