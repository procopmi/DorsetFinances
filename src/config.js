// Settings the rest of the app reads. Keeping them in one place means there is
// exactly one spot that decides which database file gets opened.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The project folder, worked out from this file's location (src/ is one level
// down), so paths work no matter which folder you start the server from.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// For now the app only ever opens the sample database inside the project.
// Opening the real file in ~/FinanceData is deliberately left for milestone 10,
// so nothing during development can touch real data.
export const dbPath = path.join(projectRoot, 'sample-data', 'sample.db');
export const isSampleData = true;

// 127.0.0.1 means "this Mac only": other devices on your network can't connect.
export const HOST = '127.0.0.1';
export const PORT = 3000;

export const publicDir = path.join(projectRoot, 'public');
