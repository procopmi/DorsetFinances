// Settings the rest of the app reads. Keeping them in one place means there is
// exactly one spot that decides which database file gets opened.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The project folder, worked out from this file's location (src/ is one level
// down), so paths work no matter which folder you start the server from.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Which database? Two modes, picked by the command you run (see package.json):
//   npm start            -> your real data, at the path FINANCE_DB in .env
//   npm run start:demo   -> the sample database inside the project
// The "--demo" flag on the command line is what selects sample data.
export const isSampleData = process.argv.includes('--demo');

export const dbPath = isSampleData
  ? path.join(projectRoot, 'sample-data', 'sample.db')
  : realDbPath();

// Reads and checks FINANCE_DB. Any problem stops the app with a plain message
// rather than guessing, because a wrong guess could mean opening (or creating)
// the wrong file and making it look as if your data had vanished.
function realDbPath() {
  const stop = (message) => {
    console.error(`Can't open your real data: ${message}`);
    console.error('(To use the sample data instead, run: npm run start:demo)');
    process.exit(1);
  };

  const file = process.env.FINANCE_DB;
  if (!file) {
    stop('FINANCE_DB is not set. Copy .env.example to .env and put your database path in it.');
  }
  if (!path.isAbsolute(file)) {
    stop(`FINANCE_DB must be a full path starting with "/", but it is "${file}".`);
  }
  if (!existsSync(path.dirname(file))) {
    stop(`the folder ${path.dirname(file)} doesn't exist. Create it first.`);
  }
  // Only the one-time setup script (which passes --setup) may start from no
  // file. Everywhere else a missing file most likely means a typo in .env, and
  // SQLite would otherwise quietly create a new, empty database there.
  if (!process.argv.includes('--setup') && !existsSync(file)) {
    stop(`${file} doesn't exist. Check the path in .env, or run "npm run setup" once to create it.`);
  }
  return file;
}

// 127.0.0.1 means "this Mac only": other devices on your network can't connect.
export const HOST = '127.0.0.1';
export const PORT = 3000;

export const publicDir = path.join(projectRoot, 'public');
