// Tests for schema versions and upgrades (see src/migrations.js). Run with: npm test
//
// The data promise: upgrading a database made by an earlier version of the
// app must end with exactly the tables a fresh one has, keep every row, and
// never leave a file half-upgraded. Each test uses throwaway in-memory
// databases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { prepareSchema, SCHEMA_VERSION } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.js';

const versionOf = (conn) => conn.prepare('PRAGMA user_version').get().user_version;

// A database as every one made before milestone 12 looks: version 0.
function versionZeroDb() {
  const conn = new DatabaseSync(':memory:');
  conn.exec(readFileSync(new URL('./fixtures/schema-v0.sql', import.meta.url), 'utf8'));
  return conn;
}

// Everything about a database's tables that matters, in a form that can be
// compared: columns (name, type, NOT NULL, default, primary key), foreign
// keys, indexes and STRICT. Compared this way rather than by the SQL text,
// which differs in spacing and comments between schema.sql and a step.
function describeTables(conn) {
  const tables = conn
    .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return tables.map(({ name, strict }) => ({
    name,
    strict,
    columns: conn.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)').all(name),
    foreignKeys: conn.prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY "from"').all(name),
    indexes: conn
      .prepare('SELECT name, "unique" FROM pragma_index_list(?) ORDER BY name')
      .all(name)
      .map((index) => ({
        ...index,
        columns: conn.prepare('SELECT name FROM pragma_index_info(?)').all(index.name).map((c) => c.name),
      })),
  }));
}

// node:sqlite returns rows without a prototype; turn them into plain objects
// so deepEqual compares just their contents.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('an upgraded old database has exactly the tables of a fresh one', () => {
  const fresh = new DatabaseSync(':memory:');
  prepareSchema(fresh);

  const old = versionZeroDb();
  const result = prepareSchema(old);

  assert.deepEqual(result, { from: 0, to: SCHEMA_VERSION });
  assert.equal(versionOf(old), SCHEMA_VERSION);
  assert.deepEqual(plain(describeTables(old)), plain(describeTables(fresh)));
});

test('a fresh database is stamped with the latest version, with no backup', () => {
  const conn = new DatabaseSync(':memory:');
  let backups = 0;
  const result = prepareSchema(conn, { beforeSchemaChange: () => backups++ });
  assert.deepEqual(result, { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  assert.equal(versionOf(conn), SCHEMA_VERSION);
  assert.equal(backups, 0);
});

test('a current database is left alone', () => {
  const conn = new DatabaseSync(':memory:');
  prepareSchema(conn);
  let backups = 0;
  prepareSchema(conn, { beforeSchemaChange: () => backups++ });
  assert.equal(backups, 0);
});

test('an older database is backed up once, then upgraded step by step, keeping its rows', () => {
  const conn = new DatabaseSync(':memory:');
  prepareSchema(conn); // at version 1
  conn.exec("INSERT INTO payees (name) VALUES ('Corner Market')");

  const events = [];
  const steps = [
    ...MIGRATIONS,
    { version: 2, about: 'Add a note column', up: (db) => { events.push('step 2'); db.exec('ALTER TABLE payees ADD COLUMN note TEXT'); } },
    { version: 3, about: 'Fill notes', up: (db) => { events.push('step 3'); db.exec("UPDATE payees SET note = 'kept'"); } },
  ];
  const result = prepareSchema(conn, { migrations: steps, beforeSchemaChange: () => events.push('backup') });

  assert.deepEqual(events, ['backup', 'step 2', 'step 3']);
  assert.deepEqual(result, { from: 1, to: 3 });
  assert.equal(versionOf(conn), 3);
  assert.deepEqual(plain(conn.prepare('SELECT name, note FROM payees').all()), [{ name: 'Corner Market', note: 'kept' }]);
});

test('a failing step leaves the database at the version before it', () => {
  const conn = new DatabaseSync(':memory:');
  prepareSchema(conn); // at version 1
  const steps = [
    ...MIGRATIONS,
    { version: 2, about: 'Add a note column', up: (db) => db.exec('ALTER TABLE payees ADD COLUMN note TEXT') },
    {
      version: 3,
      about: 'Broken step',
      up: (db) => {
        db.exec('ALTER TABLE payees ADD COLUMN other TEXT'); // undone by the rollback
        db.exec('SELECT * FROM no_such_table');
      },
    },
  ];

  assert.throws(() => prepareSchema(conn, { migrations: steps }), /version 3 \(Broken step\) failed/);
  assert.equal(versionOf(conn), 2);
  const columns = conn.prepare('SELECT name FROM pragma_table_info(?)').all('payees').map((c) => c.name);
  assert.ok(columns.includes('note'));
  assert.ok(!columns.includes('other'));
});

test('a database newer than the app is refused and not changed', () => {
  const conn = new DatabaseSync(':memory:');
  prepareSchema(conn);
  conn.exec('PRAGMA user_version = 99');
  const before = plain(describeTables(conn));

  let backups = 0;
  assert.throws(() => prepareSchema(conn, { beforeSchemaChange: () => backups++ }), /version 99/);
  assert.equal(backups, 0);
  assert.equal(versionOf(conn), 99);
  assert.deepEqual(plain(describeTables(conn)), before);
});
