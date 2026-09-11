/**
 * Serve `docs/` on localhost so the browser checks can run BEFORE a push.
 *
 * Run:  node scripts/serve.mjs [dir] [port]        (npm run serve)
 * Then: node scripts/verify-mobile.mjs http://127.0.0.1:8787/
 *       node scripts/verify-flows.mjs  http://127.0.0.1:8787/
 *
 * Why this exists: `verify-mobile`, `verify-flows` and `shoot` all default to
 * the LIVE GitHub Pages URL, so testing a docs/ change used to mean bumping
 * CACHE, committing and pushing first — publishing a build to Harish's phone in
 * order to find out whether it was any good. They all take a URL as argv[2];
 * this is the URL to give them.
 *
 * No dependencies, and it is dev tooling only — nothing here ships in docs/.
 *
 * `Cache-Control: no-store` is deliberate. The service worker caches
 * aggressively by design, and a stale local build is exactly the confusion this
 * script exists to remove.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] || 'docs';
const PORT = Number(process.argv[3] || 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  let path = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  // Refuse to walk out of the served directory. Local-only tooling, but a
  // traversal here would hand out anything on the disk to anything on the LAN.
  const safe = normalize(path).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  const file = join(ROOT, safe);
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/'
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`);
});
