import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AstCache,
  astCacheFile,
  astFor,
  astForFile,
  extractImports,
  hashContent,
  isCacheableSource,
  parseFile,
} from '../../../src/core/ast-cache.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'omnexx-ast-'));
  dirs.push(d);
  return d;
}

const SOURCE = [
  "import { readFile } from 'node:fs/promises';",
  "import type { Foo } from './foo.js';",
  "export * from './bar.js';",
  'const x = require("lodash");',
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
].join('\n');

describe('the AST cache', () => {
  it('extracts the symbols of a file', () => {
    const ast = parseFile(SOURCE);
    expect(ast.symbols.map((s) => s.name)).toContain('add');
    expect(ast.symbols.find((s) => s.name === 'add')?.kind).toBe('function');
    expect(ast.lines).toBe(7);
    expect(ast.tokens).toBeGreaterThan(0);
  });

  it('extracts the imports of a file, deduplicated and in order', () => {
    const imports = extractImports(SOURCE);
    expect(imports).toContain('node:fs/promises');
    expect(imports).toContain('./foo.js');
    expect(imports).toContain('./bar.js');
    expect(imports).toContain('lodash');
    expect(new Set(imports).size).toBe(imports.length);
  });

  it('hashes content the same way every time', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
    expect(hashContent('abc')).toHaveLength(64);
  });

  it('serves an unchanged file from the cache without reading it again', async () => {
    const root = await dir();
    const file = join(root, 'a.ts');
    await writeFile(file, SOURCE);
    const cache = new AstCache(join(root, 'cache.json'));

    const first = await astForFile(cache, 'a.ts', file);
    expect(first?.read).toBe(true);
    expect(first?.hit).toBe(false);

    const second = await astForFile(cache, 'a.ts', file);
    expect(second?.read).toBe(false);
    expect(second?.hit).toBe(true);
    expect(second?.ast.hash).toBe(first?.ast.hash);
    expect(second?.ast.symbols).toEqual(first?.ast.symbols);
  });

  it('re-reads a file that changed, and gives the new version', async () => {
    const root = await dir();
    const file = join(root, 'a.ts');
    await writeFile(file, SOURCE);
    const cache = new AstCache(join(root, 'cache.json'));
    const first = await astForFile(cache, 'a.ts', file);

    await writeFile(file, `${SOURCE}\nexport const extra = 1;\n`);
    const second = await astForFile(cache, 'a.ts', file);
    expect(second?.read).toBe(true);
    expect(second?.ast.hash).not.toBe(first?.ast.hash);
    expect(second?.ast.symbols.map((s) => s.name)).toContain('extra');
  });

  it('survives a restart: the cache file carries the parses over', async () => {
    const root = await dir();
    const file = join(root, 'a.ts');
    await writeFile(file, SOURCE);
    const cacheFile = join(root, 'cache.json');
    const first = new AstCache(cacheFile);
    await first.load();
    const parsed = await astForFile(first, 'a.ts', file);
    await first.flush();

    // A fresh cache, as a new process would find it.
    const second = new AstCache(cacheFile);
    await second.load();
    expect(second.size).toBe(1);
    const again = await astForFile(second, 'a.ts', file);
    expect(again?.read).toBe(false);
    expect(again?.ast.hash).toBe(parsed?.ast.hash);
  });

  it('keeps the same bytes under the same hash, whichever path they came from', async () => {
    const cache = new AstCache(join(await dir(), 'cache.json'));
    const one = astFor(cache, SOURCE);
    const two = astFor(cache, SOURCE);
    expect(one.hit).toBe(false);
    expect(two.hit).toBe(true);
    expect(two.ast.symbols).toEqual(one.ast.symbols);
  });

  it('forgets a file that is gone', async () => {
    const root = await dir();
    const file = join(root, 'a.ts');
    await writeFile(file, SOURCE);
    const cache = new AstCache(join(root, 'cache.json'));
    await astForFile(cache, 'a.ts', file);
    await rm(file);
    expect(await astForFile(cache, 'a.ts', file)).toBeUndefined();
  });

  it('gives each repo its own cache file', () => {
    const a = astCacheFile('/cache', '/repo/one');
    const b = astCacheFile('/cache', '/repo/two');
    expect(a).not.toBe(b);
    expect(astCacheFile('/cache', '/repo/one')).toBe(a);
  });

  it('parses only source files, and only up to a megabyte', () => {
    expect(isCacheableSource('a.ts', 100)).toBe(true);
    expect(isCacheableSource('a.py', 100)).toBe(true);
    expect(isCacheableSource('a.md', 100)).toBe(false);
    expect(isCacheableSource('a.ts', 2_000_000)).toBe(false);
  });

  it('survives a broken cache file', async () => {
    const root = await dir();
    const cacheFile = join(root, 'cache.json');
    await writeFile(cacheFile, '{not json');
    const cache = new AstCache(cacheFile);
    await cache.load();
    expect(cache.size).toBe(0);
    // The file is still usable afterwards.
    const found = astFor(cache, SOURCE);
    expect(found.hit).toBe(false);
  });

  it('writes a cache file that can be read back', async () => {
    const root = await dir();
    const cacheFile = join(root, 'nested', 'cache.json');
    const cache = new AstCache(cacheFile);
    await cache.load();
    astFor(cache, SOURCE);
    await cache.flush();
    const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toHaveLength(1);
  });
});
