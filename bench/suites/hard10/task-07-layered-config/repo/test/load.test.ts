import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/load.ts';

test('defaults plus a file', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'a.json');
  writeFileSync(f, JSON.stringify({ db: { url: 'postgres://x' } }));
  const c = loadConfig(f) as { server: { port: number }; db: { url: string } };
  assert.equal(c.server.port, 8080);
  assert.equal(c.db.url, 'postgres://x');
});
