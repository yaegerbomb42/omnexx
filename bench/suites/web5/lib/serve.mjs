// Serves a task's docs site on 127.0.0.1 so web tasks are deterministic and offline.
// Usage: node serve.mjs <siteDir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

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
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  if (path.includes('..')) return res.writeHead(400).end('bad path');
  const file = join(siteDir, path.endsWith('/') ? `${path}index.html` : path);
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
