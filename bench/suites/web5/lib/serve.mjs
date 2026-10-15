// Serves a task's docs site on 127.0.0.1 so web tasks are deterministic and offline.
// Usage: node serve.mjs <siteDir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const [siteDir, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!siteDir || !Number.isInteger(port)) {
  console.error('usage: node serve.mjs <siteDir> <port>');
  process.exit(2);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const ROOT = resolve(siteDir);

/** The file under ROOT a request path names, or null when it would leave ROOT. */
function fileFor(rawUrl) {
  let path;
  try {
    path = decodeURIComponent((rawUrl ?? '/').split(/[?#]/)[0] ?? '/');
  } catch {
    return null;
  }
  const file = resolve(ROOT, `.${path.endsWith('/') ? `${path}index.html` : path}`);
  return file.startsWith(ROOT + sep) ? file : null;
}

const server = createServer(async (req, res) => {
  const file = fileFor(req.url);
  if (!file) return res.writeHead(400).end('bad path');
  try {
    const body = await readFile(file);
    res
      .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      .end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});
server.on('error', (err) => {
  // Another run of the same task already serves the same site on this port.
  if (err.code === 'EADDRINUSE') {
    console.log(`docs already served at http://127.0.0.1:${port}/`);
    process.exit(0);
  }
  throw err;
});
server.listen(port, '127.0.0.1', () => console.log(`docs at http://127.0.0.1:${port}/`));
