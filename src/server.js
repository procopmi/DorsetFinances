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

import { dbPath, isSampleData, HOST, PORT, publicDir } from './config.js';
import * as db from './db.js';

// The API: each "METHOD /path" maps to a function whose return value is sent
// back to the browser as JSON. New milestones add lines here.
const apiRoutes = {
  'GET /api/info': () => ({ isSampleData }),
  'GET /api/accounts': () => db.listAccounts(),
};

// The browser decides how to treat a file based on this header, so each file
// type we serve needs its matching value.
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveStaticFile(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(publicDir, relative);

  // Refuse paths like "/../src/config.js" that try to climb out of public/.
  // Only files inside public/ are ever sent to the browser.
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(404).end('Not found');
    return;
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

async function handleRequest(req, res) {
  // req.url includes any "?query" part; we only route on the path.
  const { pathname } = new URL(req.url, `http://${HOST}`);
  const handler = apiRoutes[`${req.method} ${pathname}`];

  if (handler) {
    try {
      sendJson(res, 200, handler(req));
    } catch (err) {
      // Log the full error here in the terminal, but send the browser only the
      // message, so it can show something useful without crashing the server.
      console.error(err);
      sendJson(res, 500, { error: err.message });
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
