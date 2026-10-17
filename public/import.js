// Importing a bank download (CSV) into the selected account.
//
// 1. "Import CSV…" opens the file picker; the file is read here in the
//    browser and sent to the server for a preview. Nothing is saved yet.
// 2. The preview lists every row: untick any you don't want, and adjust the
//    payee and category. Rows already imported from an earlier download are
//    marked and skipped.
// 3. "Import" sends the same file back with your choices. The server makes a
//    backup, then adds the rows (marked cleared) all at once.

import { byId, postJson, runAction } from '/api.js';
import { formatCents } from '/money.js';
import {
  selectedAccount,
  findCategoryId,
  categoryLabel,
  defaultCategoryLabelForPayee,
  show as reloadRegister,
} from '/register.js';

let fileText = null;  // the chosen file's contents, sent again on commit
let accountId = null; // the account the preview was made for
let previewRows = []; // { row (from the server), use (checkbox), payee, category (inputs), tr }

const fileInput = byId('import-file');

byId('show-import').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () =>
  runAction(async () => {
    const file = fileInput.files[0];
    // Clear the picker, so choosing the same file again still triggers this.
    fileInput.value = '';
    if (!file) return;

    const account = selectedAccount();
    fileText = await file.text();
    accountId = account.id;
    const preview = await postJson('/api/import/preview', { accountId, fileText });
    showPreview(account, file.name, preview);
  })
);

byId('cancel-import').addEventListener('click', hidePreview);
byId('commit-import').addEventListener('click', () => runAction(commitImport));

function hidePreview() {
  byId('import-panel').hidden = true;
  fileText = null;
  previewRows = [];
}

function showPreview(account, fileName, preview) {
  const duplicates = preview.rows.filter((r) => r.isDuplicate).length;
  byId('import-summary').textContent =
    `${fileName}: ${preview.format.label} for "${account.name}". ` +
    `${preview.rows.length} row(s)` +
    (duplicates ? `, ${duplicates} already imported (will be skipped)` : '') +
    (preview.problems.length ? `, ${preview.problems.length} that couldn't be read (listed below)` : '') +
    '.';

  const problemItems = preview.problems.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  });
  byId('import-problems').replaceChildren(...problemItems);

  previewRows = preview.rows.map(buildPreviewRow);
  byId('import-rows').replaceChildren(...previewRows.map((p) => p.tr));
  byId('import-error').hidden = true;
  updateCommitButton();

  byId('import-panel').hidden = false;
  byId('import-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function textCell(text, className) {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  if (className) td.className = className;
  return td;
}

function inputCell(input) {
  const td = document.createElement('td');
  td.append(input);
  return td;
}

function buildPreviewRow(row) {
  const use = document.createElement('input');
  use.type = 'checkbox';
  // Already-imported rows can't be ticked: importing them again would
  // create duplicates.
  use.checked = !row.isDuplicate;
  use.disabled = row.isDuplicate;

  const payee = document.createElement('input');
  payee.type = 'text';
  payee.value = row.suggestedPayee;
  payee.setAttribute('list', 'payee-options');

  const category = document.createElement('input');
  category.type = 'text';
  category.value = categoryLabel(row.suggestedCategoryId);
  category.setAttribute('list', 'category-options');
  category.placeholder = 'uncategorized';

  // Choosing a known payee fills in its usual category, as in the register.
  payee.addEventListener('change', () => {
    if (category.value.trim() === '') category.value = defaultCategoryLabelForPayee(payee.value);
  });

  // The note: why a row is skipped, or the bank's own category as a hint.
  let note = '';
  if (row.isDuplicate) note = 'Already imported';
  else if (row.bankCategory) note = `Bank: ${row.bankCategory}`;

  const tr = document.createElement('tr');
  tr.append(
    inputCell(use),
    textCell(row.date),
    textCell(row.description),
    inputCell(payee),
    inputCell(category),
    textCell(formatCents(row.amountCents), row.amountCents < 0 ? 'col-money negative' : 'col-money'),
    textCell(note, 'muted')
  );

  const entry = { row, use, payee, category, tr };
  use.addEventListener('change', updateCommitButton);
  return entry;
}

// Shows how many rows will be imported, and greys out the ones that won't.
function updateCommitButton() {
  let count = 0;
  for (const p of previewRows) {
    p.tr.classList.toggle('skipped', !p.use.checked);
    if (p.use.checked) count++;
  }
  const button = byId('commit-import');
  button.textContent = `Import ${count} transaction(s)`;
  button.disabled = count === 0;
}

function showImportError(message, field) {
  const box = byId('import-error');
  box.textContent = message;
  box.hidden = false;
  field?.focus();
}

async function commitImport() {
  const choices = [];
  for (const p of previewRows) {
    if (!p.use.checked) continue;

    const text = p.category.value.trim();
    // Linking transfer halves during import comes next (milestone 9b); for
    // now, import the row and use "Link…" in the register afterwards.
    if (text.toLowerCase().startsWith('transfer:')) {
      showImportError(
        `${p.row.date} ${p.row.description}: transfers can't be set during import yet. ` +
          'Leave the category blank, then use "Link…" on the row in the register.',
        p.category
      );
      return;
    }
    const categoryId = findCategoryId(text);
    if (categoryId === undefined) {
      showImportError(
        `${p.row.date} ${p.row.description}: "${text}" doesn't match one category. Pick one from the suggestions.`,
        p.category
      );
      return;
    }
    choices.push({ fingerprint: p.row.fingerprint, payee: p.payee.value, categoryId });
  }

  const button = byId('commit-import');
  button.disabled = true; // stop a second click while this one is running
  try {
    const result = await postJson('/api/import/commit', { accountId, fileText, choices });
    const skipped = result.skipped ? `\n${result.skipped} were already imported and skipped.` : '';
    const backup = result.backupFile ? `\n\nA backup was saved first:\n${result.backupFile}` : '';
    alert(`Imported ${result.imported} transaction(s).${skipped}${backup}`);
  } catch (err) {
    button.disabled = false;
    throw err;
  }

  hidePreview();
  await reloadRegister();
}
