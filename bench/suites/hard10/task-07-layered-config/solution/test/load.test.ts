import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/load.ts';

test('defaults plus a file, env and argv', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'a.json');
  writeFileSync(f, JSON.stringify({ db: { url: 'postgres://x' } }));
  const r = loadConfig({ files: [f], env: { APP_SERVER__PORT: '9' }, argv: ['--log.json'] });
  assert.ok(r.ok);
  assert.deepEqual(r.config.server, { port: 9, host: '127.0.0.1' });
});
