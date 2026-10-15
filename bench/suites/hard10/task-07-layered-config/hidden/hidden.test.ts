import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Result =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; errors: { path: string; message: string }[] };
const REPO = process.env.TASK_REPO ?? '';
const { loadConfig } = (await import(`${REPO}/src/load.ts`)) as {
  loadConfig: (o: { files?: string[]; env?: Record<string, string | undefined>; argv?: string[] }) => Result;
};

const dir = mkdtempSync(join(tmpdir(), 'cfg-hidden-'));
let n = 0;
const file = (data: unknown): string => {
  const f = join(dir, `f${String(n++)}.json`);
  writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};
const base = file({ db: { url: 'postgres://base' } });

const ok = (r: Result): Record<string, unknown> => {
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.config;
};
const errPaths = (r: Result): string[] => {
  assert.ok(!r.ok, `expected errors, got ${JSON.stringify(r)}`);
  for (const e of r.errors) assert.equal(typeof e.message, 'string');
  return r.errors.map((e) => e.path).sort();
};

test('defaults and full shape', () => {
  assert.deepEqual(ok(loadConfig({ files: [base] })), {
    server: { port: 8080, host: '127.0.0.1' },
    log: { level: 'info', json: false },
    db: { url: 'postgres://base', poolSize: 10 },
    features: [],
  });
});

test('files merge in order; arrays replace', () => {
  const a = file({ server: { port: 9000 }, features: ['a', 'b'] });
  const b = file({ server: { host: '0.0.0.0' }, features: ['c'] });
  const c = ok(loadConfig({ files: [base, a, b] }));
  assert.deepEqual(c.server, { port: 9000, host: '0.0.0.0' });
  assert.deepEqual(c.features, ['c']);
});

test('env layer with coercion and case-insensitivity', () => {
  const c = ok(
    loadConfig({
      files: [base],
      env: {
        APP_SERVER__PORT: '7000',
        app_db__pool_size: '25',
        APP_LOG__JSON: 'TRUE',
        APP_FEATURES: ' x, y ,,z ',
        APP_LOG__LEVEL: 'debug',
        HOME: '/root',
        PATH: '/bin',
        APP_UNSET: undefined,
      },
    }),
  );
  assert.deepEqual(c.server, { port: 7000, host: '127.0.0.1' });
  assert.deepEqual(c.db, { url: 'postgres://base', poolSize: 25 });
  assert.deepEqual(c.log, { level: 'debug', json: true });
  assert.deepEqual(c.features, ['x', 'y', 'z']);
  assert.deepEqual((ok(loadConfig({ files: [base], env: { APP_LOG__JSON: '0' } })).log as { json: boolean }).json, false);
});

test('env can supply the required key without files', () => {
  const c = ok(loadConfig({ env: { APP_DB__URL: 'sqlite://mem' } }));
  assert.deepEqual(c.db, { url: 'sqlite://mem', poolSize: 10 });
  assert.deepEqual(ok(loadConfig({ argv: ['--db.url=x'] })).db, { url: 'x', poolSize: 10 });
});

test('argv beats env beats files', () => {
  const f = file({ server: { port: 1000 }, log: { json: true } });
  const c = ok(
    loadConfig({
      files: [base, f],
      env: { APP_SERVER__PORT: '2000', APP_LOG__JSON: 'true' },
      argv: ['build', '--server.port=3000', '--no-log.json', '--features=p,q', 'extra'],
    }),
  );
  assert.equal((c.server as { port: number }).port, 3000);
  assert.equal((c.log as { json: boolean }).json, false);
  assert.deepEqual(c.features, ['p', 'q']);
  assert.equal((ok(loadConfig({ files: [base], argv: ['--log.json'] })).log as { json: boolean }).json, true);
  assert.equal(
    (ok(loadConfig({ files: [base], argv: ['--db.poolSize=3'] })).db as { poolSize: number }).poolSize,
    3,
  );
});

test('collects every error with its path', () => {
  const bad = file({
    server: { port: 70000, prot: 1, host: 5 },
    log: { level: 'loud', json: 'yes' },
    db: { poolSize: 2.5 },
    features: ['ok', 3],
    extra: true,
  });
  const paths = errPaths(loadConfig({ files: [bad] }));
  assert.deepEqual(paths, [
    'db.poolSize',
    'db.url',
    'extra',
    'features',
    'log.json',
    'log.level',
    'server.host',
    'server.port',
    'server.prot',
  ]);
});

test('env and argv errors', () => {
  const paths = errPaths(
    loadConfig({
      files: [base],
      env: { APP_SERVER__PORT: '80a', APP_SERVER__PROT: '1', APP_LOG__JSON: 'maybe' },
      argv: ['--db.poolSize=0', '--nope=1'],
    }),
  );
  assert.deepEqual(paths, ['db.poolSize', 'log.json', 'nope', 'server.port', 'server.prot']);
  assert.deepEqual(errPaths(loadConfig({ files: [base], env: { APP_SERVER__PORT: '1e3' } })), ['server.port']);
});

test('json strings are not coerced', () => {
  assert.deepEqual(errPaths(loadConfig({ files: [file({ db: { url: 'u', poolSize: '5' } })] })), [
    'db.poolSize',
  ]);
});

test('unreadable or invalid files report the file path', () => {
  const broken = file('{ not json');
  const missing = join(dir, 'missing.json');
  const paths = errPaths(loadConfig({ files: [base, broken, missing] }));
  assert.deepEqual(paths, [broken, missing].sort());
});

test('schema is the single source of truth', async () => {
  const schemaSrc = readFileSync(`${REPO}/src/schema.ts`, 'utf-8');
  assert.match(schemaSrc, /SCHEMA/);
  const { SCHEMA } = (await import(`${REPO}/src/schema.ts`)) as { SCHEMA: Record<string, unknown> };
  assert.deepEqual(Object.keys(SCHEMA).sort(), [
    'db.poolSize',
    'db.url',
    'features',
    'log.json',
    'log.level',
    'server.host',
    'server.port',
  ]);
});
