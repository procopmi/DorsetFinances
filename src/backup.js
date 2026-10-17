// Timestamped backup copies of the database file.
//
// The project rule is "back up before risk": before any import or schema
// change, a copy of the data file is made, so a bad import can be undone by
// putting the copy back. Backups go in a "backups" folder next to the
// database file: ~/FinanceData/backups/ for real data, sample-data/backups/
// for the sample data. git ignores both.

import path from 'node:path';
import { mkdirSync } from 'node:fs';

import { dbPath } from './config.js';
import * as db from './db.js';

// Copies the open database and returns the new file's path. `reason` goes in
// the file name, e.g. "finance-2026-10-16_143005-123-import.db".
export function makeBackup(reason) {
  const folder = path.join(path.dirname(dbPath), 'backups');
  mkdirSync(folder, { recursive: true });

  const now = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  // Down to the millisecond, so two backups in the same second don't collide.
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;

  const file = path.join(folder, `${path.basename(dbPath, '.db')}-${stamp}-${reason}.db`);
  db.backupTo(file);
  return file;
}
