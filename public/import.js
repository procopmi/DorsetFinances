// Importing a bank download (CSV) into the selected account.
//
// 1. "Import CSV…" opens the file picker; the file is read here in the
//    browser and sent to the server for a preview. Nothing is saved yet.
// 2. The preview lists every row: untick any you don't want, and adjust the
//    payee and category. For each row the server may also have found:
//      - a row you entered by hand that this is the bank's copy of (ticked:
//        your row is marked cleared instead of a new one being added);
//      - the other half of a transfer already in another account (ticked:
//        the two are linked);
//      - a remembered rule that chose the payee;
//      - the payee's amount rule, which chose the category by amount.
//    Rows already imported from an earlier download are marked and skipped.
// 3. "Import" sends the same file back with your choices. The server makes a
//    backup, then makes all the changes at once.

import { byId, postJson, runAction } from '/api.js';
import { formatCents } from '/money.js';
import {
  selectedAccount,
  findCategoryId,
  categoryLabel,
  defaultCategoryLabelForPayee,
  show as reloadRegister,
} from '/register.js';
import { RULE_WORDS } from '/payees.js';

let fileText = null;  // the chosen file's contents, sent again on commit
let accountId = null; // the account the preview was made for
let previewRows = []; // one entry per row: the server's row plus its inputs (see buildPreviewRow)

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
  const count = (test) => preview.rows.filter(test).length;
  const duplicates = count((r) => r.isDuplicate);
  const handEntered = count((r) => r.handEntered);
  const transfers = count((r) => r.transferMatch);
  const parts = [`${preview.rows.length} row(s)`];
  if (duplicates) parts.push(`${duplicates} already imported (will be skipped)`);
  if (handEntered) parts.push(`${handEntered} matching rows you entered by hand`);
  if (transfers) parts.push(`${transfers} matching transfers in other accounts`);
  if (preview.reinvestmentsSkipped) {
    parts.push(`${preview.reinvestmentsSkipped} reinvestment row(s) ignored (cash balance only)`);
  }
  if (preview.problems.length) parts.push(`${preview.problems.length} that couldn't be read (listed below)`);
  byId('import-summary').textContent =
    `${fileName}: ${preview.format.label} for "${account.name}". ${parts.join(', ')}.`;

  const problemItems = preview.problems.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  });
  byId('import-problems').replaceChildren(...problemItems);

  previewRows = preview.rows.map(buildPreviewRow);
  byId('import-rows').replaceChildren(...previewRows.map((p) => p.tr));
  byId('import-error').hidden = true;
  updateRows();

  byId('import-panel').hidden = false;
  byId('import-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Building one preview row ---

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

function textInput(value, listId) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  if (listId) input.setAttribute('list', listId);
  return input;
}

// A checkbox with its label, as one line of the Note column.
function checkLine(text, checked) {
  const label = document.createElement('label');
  label.className = 'note-line';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  label.append(box, ` ${text}`);
  return { label, box };
}

function noteLine(text) {
  const div = document.createElement('div');
  div.className = 'note-line muted';
  div.textContent = text;
  return div;
}

function buildPreviewRow(row) {
  const use = document.createElement('input');
  use.type = 'checkbox';
  // Already-imported rows can't be ticked: importing them again would
  // create duplicates.
  use.checked = !row.isDuplicate;
  use.disabled = row.isDuplicate;

  const payee = textInput(row.suggestedPayee, 'payee-options');
  const category = textInput(categoryLabel(row.suggestedCategoryId), 'category-options');
  category.placeholder = 'uncategorized';

  const entry = { row, use, payee, category, handEnteredBox: null, linkBox: null, rememberBox: null, patternInput: null };
  const note = document.createElement('td');
  note.className = 'import-note';

  if (row.isDuplicate) {
    note.append(noteLine('Already imported'));
  } else {
    if (row.handEntered) {
      const h = row.handEntered;
      const details = [h.date, h.payee ?? h.memo, h.check_number && `#${h.check_number}`].filter(Boolean).join(' · ');
      const { label, box } = checkLine(`Same as your entry ${details}: use it instead of adding a new row`, true);
      entry.handEnteredBox = box;
      note.append(label);
    } else if (row.transferMatch) {
      const t = row.transferMatch;
      const { label, box } = checkLine(
        `Link as transfer with ${formatCents(t.amount_cents)} in ${t.account} (${t.date})`,
        true
      );
      entry.linkBox = box;
      note.append(label);
    } else if (row.looksLikeTransfer) {
      note.append(
        noteLine(
          row.otherTransferMatches > 1
            ? 'Looks like a transfer, with several possible matches: use "Link…" in the register afterwards.'
            : "Looks like a transfer: import the other account's file too, or use \"Link…\" later."
        )
      );
    }

    if (row.amountRule) {
      const threshold = row.amountRule.thresholdCents;
      const side = Math.abs(row.amountCents) < threshold ? 'under' : 'at least';
      note.append(noteLine(`Category by amount: ${side} $${formatCents(threshold)}`));
    }

    if (row.rule) {
      note.append(noteLine(`Rule: ${RULE_WORDS[row.rule.matchType]} "${row.rule.pattern}"`));
    } else {
      // Offered once you've changed the payee from the bank's text: save a
      // rule so future imports get this payee automatically.
      const { label, box } = checkLine('Remember: bank text containing', false);
      const pattern = textInput(row.suggestedPattern);
      pattern.className = 'pattern-input';
      label.append(pattern, ` → this payee`);
      entry.rememberBox = box;
      entry.patternInput = pattern;
      entry.rememberLine = label;
      note.append(label);
    }

    if (row.bankCategory) note.append(noteLine(`Bank: ${row.bankCategory}`));
  }

  // Choosing a known payee fills in its usual category, as in the register
  // (or the category its amount rule gives for this row's amount).
  payee.addEventListener('change', () => {
    if (category.value.trim() === '') category.value = defaultCategoryLabelForPayee(payee.value, row.amountCents);
  });
  for (const control of [use, payee, entry.handEnteredBox, entry.linkBox]) {
    control?.addEventListener(control === payee ? 'input' : 'change', updateRows);
  }

  const tr = document.createElement('tr');
  tr.append(
    inputCell(use),
    textCell(row.date),
    textCell(row.description),
    inputCell(payee),
    inputCell(category),
    textCell(formatCents(row.amountCents), row.amountCents < 0 ? 'col-money negative' : 'col-money'),
    note
  );
  entry.tr = tr;
  return entry;
}

// Keeps every row's controls consistent with its choices, and the Import
// button's count up to date.
function updateRows() {
  let count = 0;
  for (const p of previewRows) {
    p.tr.classList.toggle('skipped', !p.use.checked);
    if (p.use.checked) count++;

    // Using your hand-entered row keeps your payee and category, so those
    // boxes don't apply; a linked transfer has no category.
    const usesHandEntered = Boolean(p.handEnteredBox?.checked);
    p.payee.disabled = usesHandEntered;
    p.category.disabled = usesHandEntered || Boolean(p.linkBox?.checked);

    // "Remember" only makes sense when the payee differs from the bank text.
    if (p.rememberLine) {
      const changed = p.payee.value.trim() !== '' && p.payee.value.trim() !== p.row.description;
      p.rememberLine.hidden = !changed || usesHandEntered;
    }
  }
  const button = byId('commit-import');
  button.textContent = `Import ${count} transaction(s)`;
  button.disabled = count === 0;
}

// --- Importing ---

function showImportError(message, field) {
  const box = byId('import-error');
  box.textContent = message;
  box.hidden = false;
  field?.focus();
}

// The choices the server needs for one ticked row, or null after showing a
// problem (with the cursor put in the box to fix).
function readChoice(p) {
  const where = `${p.row.date} ${p.row.description}`;
  const choice = { fingerprint: p.row.fingerprint, payee: p.payee.value, categoryId: null };

  if (p.handEnteredBox?.checked) {
    choice.handEnteredId = p.row.handEntered.id;
    return choice;
  }
  if (p.linkBox?.checked) {
    choice.linkToId = p.row.transferMatch.id;
  } else {
    const text = p.category.value.trim();
    // A transfer can only be made during import by linking to a matching
    // row (above); otherwise import it and use "Link…" in the register.
    if (text.toLowerCase().startsWith('transfer:')) {
      showImportError(
        `${where}: a transfer can't be typed in during import. Leave the category blank, ` +
          'then use "Link…" on the row in the register (or import the other account\'s file first).',
        p.category
      );
      return null;
    }
    const categoryId = findCategoryId(text);
    if (categoryId === undefined) {
      showImportError(`${where}: "${text}" doesn't match one category. Pick one from the suggestions.`, p.category);
      return null;
    }
    choice.categoryId = categoryId;
  }

  if (p.rememberBox?.checked && !p.rememberLine.hidden) {
    if (p.patternInput.value.trim() === '') {
      showImportError(`${where}: type the text to look for, or untick Remember.`, p.patternInput);
      return null;
    }
    choice.rememberPattern = p.patternInput.value;
  }
  return choice;
}

// The closing message's line comparing your cleared balance with the bank's.
function balanceCheckText(result) {
  if (!result.bankBalance) return '';
  const bank = result.bankBalance.cents;
  const yours = result.clearedBalanceCents;
  const line =
    `\n\nBank's balance as of ${result.bankBalance.date}: ${formatCents(bank)}` +
    `\nYour cleared balance: ${formatCents(yours)}`;
  return bank === yours
    ? `${line}\nThey match, so you can use "Mark cleared as reconciled".`
    : `${line}\nThey differ by ${formatCents(Math.abs(bank - yours))}.`;
}

async function commitImport() {
  const choices = [];
  for (const p of previewRows) {
    if (!p.use.checked) continue;
    const choice = readChoice(p);
    if (!choice) return;
    choices.push(choice);
  }

  const button = byId('commit-import');
  button.disabled = true; // stop a second click while this one is running
  let result;
  try {
    result = await postJson('/api/import/commit', { accountId, fileText, choices });
  } catch (err) {
    button.disabled = false;
    throw err;
  }

  const lines = [`Added ${result.added} new transaction(s).`];
  if (result.matched) lines.push(`Marked ${result.matched} of your own entries as cleared.`);
  if (result.linked) lines.push(`Linked ${result.linked} transfer(s).`);
  if (result.rules) lines.push(`Remembered ${result.rules} payee rule(s).`);
  if (result.skipped) lines.push(`Skipped ${result.skipped} already imported.`);
  const backup = result.backupFile ? `\n\nA backup was saved first:\n${result.backupFile}` : '';
  alert(lines.join('\n') + balanceCheckText(result) + backup);

  hidePreview();
  await reloadRegister();
}
