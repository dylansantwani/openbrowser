#!/usr/bin/env node
/**
 * Static file server for the UI preview.
 *
 * The preview needs `fetch` and ES module imports, which the file:// protocol
 * blocks. This serves the project directory over http so both work.
 *
 *   node scripts/serve-preview.mjs   ->  http://localhost:8850
 *
 * Development only. It has no place in the shipped extension.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.env.PORT) || 8850;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/scripts/dev-preview/index.html';

  // Contain requests to the project directory. This only ever binds loopback,
  // but a traversal bug in a dev server is still a bug.
  const target = resolve(join(ROOT, normalize(pathname)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Lets the content scripts be pulled into a real third-party page for
      // testing the accessibility tree against sites we do not control.
      // Dev server only, loopback only.
      'access-control-allow-origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${pathname}`);
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`UI preview on http://localhost:${PORT}\n`);
});
