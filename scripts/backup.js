// Makes a timestamped backup copy of the database the app uses.
//
// Run with: npm run backup        (your real data)
//      or:  npm run backup:demo   (the sample data)
// It only reads the database, so it's safe to run while the app is open.
// The app also makes a backup by itself before every import.

import { dbPath } from '../src/config.js';
import * as db from '../src/db.js';
import { makeBackup } from '../src/backup.js';

// An older database may first get a newly added table; that's backed up first too.
db.openDb(dbPath, { beforeSchemaChange: () => console.log(`Backup before adding new tables: ${makeBackup('schema')}`) });
console.log(`Backup saved to ${makeBackup('manual')}`);
