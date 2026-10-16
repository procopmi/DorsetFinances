// The web server. It does two jobs:
//   1. Serves the files in public/ (the HTML, CSS and JavaScript the browser runs).
//   2. Answers small JSON "API" requests under /api/ by calling functions in db.js.
//
// It uses Node's built-in http module rather than a framework like Express. We
// only need a handful of routes, and this keeps the app at zero npm packages.

import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { dbPath, isSampleData, HOST, PORT, publicDir } from './config.js';
import * as db from './db.js';
import { runningBalances } from './money.js';

// --- Input checks ---
//
// The browser checks input too, but the server checks again: it is the last
// stop before the database, so it must never trust what it's sent.

const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card'];

// An Error carrying an HTTP status code. 400 means "your request was wrong";
// 404 means "no such thing". Anything without a status is reported as 500,
// meaning "the server itself hit a problem".
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function requireId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw httpError(400, 'Invalid id');
  return value;
}

function requireName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw httpError(400, 'A name is required');
  return value.trim();
}

// Money must arrive as whole cents. A decimal here means a bug somewhere.
function requireCents(value) {
  if (!Number.isSafeInteger(value)) throw httpError(400, 'Amount must be whole cents');
  return value;
}

// 'YYYY-MM-DD', and a real calendar date (rejects 2026-02-30 and 2026-13-01).
function requireDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  const isRealDate =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    // An impossible month gives an "invalid date" (NaN); check before using it.
    !Number.isNaN(parsed.getTime()) &&
    // An impossible day like Feb 30 rolls over to Mar 2, so compare back.
    parsed.toISOString().slice(0, 10) === value;
  if (!isRealDate) throw httpError(400, `"${value}" is not a valid date`);
  return value;
}

// Optional text such as a memo: blank becomes null (nothing stored), and very
// long values are refused rather than silently cut short.
function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw httpError(400, `${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw httpError(400, `${label} is too long (max ${maxLength})`);
  return trimmed === '' ? null : trimmed;
}

// The register fields shared by "add" and "edit".
function readTransactionFields(body) {
  return {
    date: requireDate(body.date),
    checkNumber: optionalText(body.checkNumber, 'Check number', 20),
    payeeName: optionalText(body.payee, 'Payee', 100),
    memo: optionalText(body.memo, 'Memo', 200),
    amountCents: requireCents(body.amountCents),
  };
}

// --- API routes ---
//
// Each "METHOD /path" maps to a function that receives the request's input:
// for POST, the parsed JSON body; for GET, the "?name=value" query parameters
// (which always arrive as text). Whatever it returns is sent back as JSON.
// Ids travel in the input (not the URL path) so this table stays a simple lookup.

const apiRoutes = {
  'GET /api/info': () => ({ isSampleData }),

  'GET /api/accounts': () => db.listAccounts(),

  // One account's register: its transactions in order, each with the running
  // balance after it. The balance is calculated here, fresh, on every request.
  'GET /api/register': (query) => {
    // Query values are text ("3"), so convert to a number before checking.
    const accountId = requireId(Number(query.accountId));
    const account = db.getAccount(accountId);
    if (!account) throw httpError(404, 'No such account');

    const rows = db.getRegister(accountId);
    const balances = runningBalances(
      account.opening_balance_cents,
      rows.map((row) => row.amount_cents)
    );

    return {
      openingBalanceCents: account.opening_balance_cents,
      openingDate: account.opening_date,
      rows: rows.map((row, i) => ({ ...row, balance_cents: balances[i] })),
    };
  },

  'GET /api/payees': () => db.listPayees(),

  'POST /api/transactions': (body) => {
    const accountId = requireId(body.accountId);
    if (!db.getAccount(accountId)) throw httpError(404, 'No such account');
    const id = db.createTransaction({ accountId, ...readTransactionFields(body) });
    return { id };
  },

  'POST /api/transactions/update': (body) => {
    if (!db.updateTransaction(requireId(body.id), readTransactionFields(body))) {
      throw httpError(404, 'No such transaction');
    }
    return { ok: true };
  },

  // The page asks for confirmation before calling this.
  'POST /api/transactions/delete': (body) => {
    if (!db.deleteTransaction(requireId(body.id))) throw httpError(404, 'No such transaction');
    return { ok: true };
  },

  'POST /api/accounts': (body) => {
    if (!ACCOUNT_TYPES.includes(body.type)) throw httpError(400, 'Unknown account type');
    const id = db.createAccount({
      name: requireName(body.name),
      type: body.type,
      openingBalanceCents: requireCents(body.openingBalanceCents),
      openingDate: requireDate(body.openingDate),
    });
    return { id };
  },

  'POST /api/accounts/rename': (body) => {
    if (!db.renameAccount(requireId(body.id), requireName(body.name))) {
      throw httpError(404, 'No such account');
    }
    return { ok: true };
  },

  'POST /api/accounts/set-closed': (body) => {
    if (!db.setAccountClosed(requireId(body.id), body.isClosed === true)) {
      throw httpError(404, 'No such account');
    }
    return { ok: true };
  },

  'POST /api/accounts/delete': (body) => {
    const id = requireId(body.id);
    // Deleting an account with history would destroy that history, so refuse
    // and point to closing instead, which hides it but keeps everything.
    const count = db.countTransactions(id);
    if (count > 0) {
      throw httpError(400, `This account has ${count} transaction(s). Close it instead of deleting it.`);
    }
    if (!db.deleteAccount(id)) throw httpError(404, 'No such account');
    return { ok: true };
  },
};

// --- Request plumbing ---

// The browser decides how to treat a file based on this header, so each file
// type we serve needs its matching value.
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Files outside public/ that the browser is allowed to load. money.js is
// shared so the page parses and formats amounts with exactly the same (tested)
// code as the server. Listing files one by one keeps the rest of src/ private.
const sharedFiles = {
  '/money.js': fileURLToPath(new URL('./money.js', import.meta.url)),
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, 'Request body is not valid JSON');
  }
  // Every route expects an object like {"id": 3}, so reject anything else
  // (such as a bare number or null) up front.
  if (typeof body !== 'object' || body === null) throw httpError(400, 'Request body must be a JSON object');
  return body;
}

async function serveStaticFile(res, urlPath) {
  let filePath = sharedFiles[urlPath];

  if (!filePath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    filePath = path.join(publicDir, relative);

    // Refuse paths like "/../src/config.js" that try to climb out of public/.
    // Only files inside public/ (plus sharedFiles) are ever sent to the browser.
    if (!filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(404).end('Not found');
      return;
    }
  }

  try {
    const body = await readFile(filePath);
    const type = contentTypes[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// Two guards against other websites open in your browser reaching this server.
// Even though the server only listens on this Mac, any web page you visit can
// try to send requests to 127.0.0.1.
function isTrustedRequest(req) {
  // 1. The Host header must be our own address. This blocks a trick called
  //    "DNS rebinding", where a hostile site's domain is pointed at 127.0.0.1.
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return false;

  // 2. Changes (POST) must be sent as JSON. Browsers won't let another site
  //    send a JSON POST to us without first asking permission, and this server
  //    never grants it, so only our own page can make changes.
  if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
    return false;
  }
  return true;
}

async function handleRequest(req, res) {
  if (!isTrustedRequest(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  // req.url includes any "?query" part; we route on the path alone.
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  const handler = apiRoutes[`${req.method} ${pathname}`];

  if (handler) {
    try {
      const input =
        req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(searchParams);
      sendJson(res, 200, handler(input));
    } catch (err) {
      // Expected problems (bad input, missing account) carry a status and just
      // send their message. Anything else is a bug: log it in the terminal.
      if (!err.status) console.error(err);
      sendJson(res, err.status ?? 500, { error: err.message });
    }
  } else if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: `No API route for ${req.method} ${pathname}` });
  } else if (req.method === 'GET') {
    await serveStaticFile(res, pathname);
  } else {
    res.writeHead(405).end('Method not allowed');
  }
}

// --- Start up ---

// The sample-data folder holds a generated file that git ignores, so it may
// not exist yet on a fresh checkout. Create it before SQLite tries to write there.
mkdirSync(path.dirname(dbPath), { recursive: true });
db.openDb(dbPath);

http.createServer(handleRequest).listen(PORT, HOST, () => {
  console.log(`Database: ${dbPath}${isSampleData ? '  (SAMPLE DATA)' : ''}`);
  console.log(`Open http://${HOST}:${PORT} in your browser. Press Ctrl+C to stop.`);
});
