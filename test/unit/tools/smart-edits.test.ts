import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lineTag, locateRange, rangeHash } from '../../../src/tools/anchors.js';
import { closeMatches } from '../../../src/tools/did-you-mean.js';
import { multiEditTool, strReplaceTool, writeFileTool } from '../../../src/tools/edit.js';
import { fuzzyReplace } from '../../../src/tools/fuzzy-match.js';
import { outlineTool } from '../../../src/tools/outline.js';
import { afterEdit, newDiags, renderDiags } from '../../../src/tools/post-edit.js';
import { readTool } from '../../../src/tools/read.js';
import { replaceLinesTool } from '../../../src/tools/replace-lines.js';
import { disposeCheckers } from '../../../src/tools/ts-check.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

afterAll(disposeCheckers);

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', ''];

async function repo(files: Record<string, string> = { 'src/f.ts': FILE.join('\n') }) {
  const root = await tempDir();
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true });
    await writeFile(join(root, p), text);
  }
  return { root, ctx: await toolContext(root) };
}

describe('line anchors', () => {
  it('read with anchors tags each line; without, output is unchanged', async () => {
    const { ctx } = await repo();
    const plain = (await readTool.run({ path: 'src/f.ts' }, ctx)).content;
    expect(plain).toContain('    2    return 1;');
    const anchored = (await readTool.run({ path: 'src/f.ts', anchors: true }, ctx)).content;
    expect(anchored).toContain(`    2 ${lineTag('  return 1;')}   return 1;`);
    // Token cost: two characters per line (about one token).
    expect(anchored.length - plain.length).toBe(FILE.length * 2);
  });

  it('locateRange accepts, follows a moved range, and rejects a changed one', () => {
    const hash = rangeHash(FILE, 5, 7);
    expect(locateRange(FILE, 5, 7, hash)).toEqual({ ok: true, start: 5, end: 7, moved: false });
    const shifted = ['// header', '// more', ...FILE];
    expect(locateRange(shifted, 5, 7, hash)).toEqual({ ok: true, start: 7, end: 9, moved: true });
    const changed = FILE.map((l) => (l === 'function b() {' ? 'function c() {' : l));
    const r = locateRange(changed, 5, 7, hash);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/anchor mismatch: lines 5-7 .*"function c\(\) \{"/);
    expect(locateRange(FILE, 3, 2, undefined).ok).toBe(false);
  });

  it('locateRange recovers a multi-line range in the nearby window when the full scan finds nothing unique', () => {
    // Build a file where the same boundary tags appear twice, far apart, but one instance is near the original position
    const block = ['function x() {', '  return 99;', '}'];
    const padding = Array.from({ length: 40 }, (_, i) => `// line ${i}`);
    const lines = [...block, ...padding, ...block, ''];
    const hash = rangeHash(lines, 1, 3);
    // Full-file scan finds 2 matches -> no unique hit -> falls through to nearby window
    // Nearby window (+-15 from original start=1) finds only the first instance
    const shifted = ['// header', ...lines];
    const r = locateRange(shifted, 1, 3, hash);
    expect(r).toEqual({ ok: true, start: 2, end: 4, moved: true });
  });

  it('locateRange still rejects a multi-line range when content actually changed', () => {
    const hash = rangeHash(FILE, 5, 7);
    const changed = FILE.map((l) => (l === 'function b() {' ? 'function c() {' : l));
    const r = locateRange(changed, 5, 7, hash);
    expect(r.ok).toBe(false);
  });

  it('locateRange rejects multi-line drift when two matches exist in the nearby window', () => {
    const block = ['unique_start();', '  middle();', 'unique_end();'];
    const lines = [...block, '', ...block, ''];
    const hash = rangeHash(lines, 1, 3);
    const shifted = ['// header', ...lines];
    const r = locateRange(shifted, 1, 3, hash);
    expect(r.ok).toBe(false);
  });

  it('replace_lines edits by range, follows drift, refuses stale anchors', async () => {
    const { root, ctx } = await repo();
    const hash = rangeHash(FILE, 5, 7);
    await writeFile(join(root, 'src/f.ts'), ['// new header', ...FILE].join('\n'));
    const r = await replaceLinesTool.run(
      { path: 'src/f.ts', start: 5, end: 7, expected_hash: hash, new_text: 'const b = 2;\n' },
      ctx,
    );
    expect(r.content).toMatch(/replaced lines 6-8 .* with 1; the lines had moved/);
    expect(await readFile(join(root, 'src/f.ts'), 'utf8')).toContain('}\n\nconst b = 2;\n');
    const stale = await replaceLinesTool.run(
      { path: 'src/f.ts', start: 2, end: 4, expected_hash: 'aaaa', new_text: '' },
      ctx,
    );
    expect(stale.isError).toBe(true);
    expect(stale.content).toMatch(/No changes were written/);
    expect(ctx.edited.has('src/f.ts')).toBe(true);
  });
});

describe('whitespace-tolerant str_replace', () => {
  it('matches despite indentation drift and re-indents new_str', () => {
    const r = fuzzyReplace(FILE.join('\n'), 'return 2;', 'if (x) {\n  return 3;\n}');
    expect(r).toMatchObject({ found: 1, start: 6, end: 6, reindented: true });
    expect(r.found === 1 && r.text).toContain('  if (x) {\n    return 3;\n  }\n}');
  });

  it('reports every place when the loose match is ambiguous', () => {
    expect(fuzzyReplace('  x\ny\n x\n', 'x', 'z')).toEqual({ found: 'many', lines: [1, 3] });
    expect(fuzzyReplace('a\n', 'nope', 'z')).toEqual({ found: 0 });
    expect(fuzzyReplace('a\n', '\n\n', 'z')).toEqual({ found: 0 });
  });

  it('str_replace applies the loose match and says so; ambiguity writes nothing', async () => {
    const { root, ctx } = await repo();
    const bad = await multiEditTool.run(
      { path: 'src/f.ts', edits: [{ old_str: '   }', new_str: 'Y' }] },
      ctx,
    );
    expect(bad.content).toMatch(/found 2 times ignoring whitespace in src\/f.ts \(at lines 3, 7\)/);
    expect(await readFile(join(root, 'src/f.ts'), 'utf8')).not.toContain('Y');
    const r = await strReplaceTool.run(
      { path: 'src/f.ts', old_str: 'function b() {\n    return   2;\n}', new_str: 'X' },
      ctx,
    );
    expect(r.content).toMatch(/matched lines 5-7 ignoring whitespace/);
  });
});

describe('did you mean', () => {
  it('suggests close paths for missing files in read, edit and outline', async () => {
    const { root, ctx } = await repo({ 'src/tools/edit.ts': 'x', 'src/other.ts': 'y' });
    expect(await closeMatches(root, 'src/tool/edit.ts')).toEqual(['src/tools/edit.ts']);
    expect((await readTool.run({ path: 'src/tools/edits.ts' }, ctx)).content).toMatch(
      /cannot read .*ENOENT\. Did you mean src\/tools\/edit\.ts\?/,
    );
    const edit = await strReplaceTool.run(
      { path: 'tools/edit.ts', old_str: 'x', new_str: 'z' },
      ctx,
    );
    expect(edit.content).toMatch(/Did you mean src\/tools\/edit\.ts\? Use write_file/);
    expect((await outlineTool.run({ path: 'src/edit.ts' }, ctx)).content).toMatch(/Did you mean/);
    expect(await closeMatches(root, 'zzzzzzzzzzzzzzz.py')).toEqual([]);
  });
});

describe('post-edit formatting', () => {
  it('runs the configured project formatter and reports it', async () => {
    const { root, ctx } = await repo({ 'a.ts': 'x\n', '.prettierrc': '{}' });
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    const bin = join(root, 'node_modules/.bin/prettier');
    await writeFile(bin, '#!/bin/sh\nfor f; do :; done\necho "// formatted" >> "$f"\n');
    await chmod(bin, 0o755);
    const r = await writeFileTool.run({ path: 'a.ts', content: 'const a = 1;\n' }, ctx);
    expect(r.content).toMatch(/Formatted with prettier/);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('// formatted');
  });

  it('never fails or formats without a config, or in a sandbox', async () => {
    const { root, ctx } = await repo({ 'a.ts': 'x\n' });
    expect(await afterEdit(ctx, join(root, 'a.ts'), '')).toBe('');
    const sandboxed = await toolContext(root, {
      exec: () => Promise.reject(new Error('sandbox must not run')),
    });
    expect(await afterEdit(sandboxed, join(root, 'a.ts'), '')).toBe('');
  });
});

describe('post-edit diagnostics', () => {
  it('keeps only problems the edit introduced, compactly', () => {
    const old = { line: 1, code: 'TS1', message: 'old' };
    const added = { line: 9, code: 'TS2', message: 'new' };
    expect(newDiags([old], [old, added])).toEqual([added]);
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...added,
      line: i,
      message: 'm'.repeat(300),
    }));
    const text = renderDiags(many);
    expect(text.split('\n')).toHaveLength(5); // leading newline + 3 rows + "(+2 more)"
    expect(text).toContain('(+2 more)');
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(160);
    expect(renderDiags([])).toBe('');
  });

  it('reports a new TypeScript error from the repo’s own compiler, warm across edits', async () => {
    const { root, ctx } = await repo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
      'src/a.ts': 'export const n: number = 1;\n',
    });
    await mkdir(join(root, 'node_modules'));
    await symlink(resolve('node_modules/typescript'), join(root, 'node_modules/typescript'));
    const abs = join(root, 'src/a.ts');
    const before = await readFile(abs, 'utf8');
    await writeFile(abs, "export const n: number = 'x';\n");
    const cold = await afterEdit(ctx, abs, before, { diagTimeoutMs: 60_000 });
    expect(cold).toMatch(/⚠ line 1: TS2322 Type 'string' is not assignable to type 'number'/);
    // Warm: the default 1.5s budget is enough now, through the real edit tool.
    const r = await strReplaceTool.run(
      { path: 'src/a.ts', old_str: "'x'", new_str: '2;\nexport const s: string = 3' },
      ctx,
    );
    expect(r.content).toMatch(/^edited src\/a\.ts \(1 replacement\)\n⚠ line 2: TS2322/);
  }, 90_000);

  it('reports a new Python syntax error when python3 exists', async () => {
    try {
      execFileSync('python3', ['--version']);
    } catch {
      return; // no python3 on this machine
    }
    const { root, ctx } = await repo({ 'a.py': 'x = 1\n' });
    const r = await strReplaceTool.run({ path: 'a.py', old_str: 'x = 1', new_str: 'def f(:' }, ctx);
    expect(r.content).toMatch(/⚠ line 1: SyntaxError/);
    expect(r.content).toContain('Mutation discarded without writing to disk');
    // Verify file content on disk remained unchanged
    expect(await readFile(join(root, 'a.py'), 'utf8')).toBe('x = 1\n');
    expect(root).toBeTruthy();
  });

  it('rejects TypeScript edits with syntax errors before mutating disk', async () => {
    const { root, ctx } = await repo({
      'tsconfig.json': '{ "compilerOptions": { "target": "es2022" } }\n',
      'src/a.ts': 'export const n: number = 1;\n',
    });
    const r = await strReplaceTool.run(
      {
        path: 'src/a.ts',
        old_str: 'export const n: number = 1;',
        new_str: 'export const n: number = ;',
      },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Syntax error in proposed edit at line 1.*TS1109/);
    expect(r.content).toContain('Mutation discarded without writing to disk');
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('export const n: number = 1;\n');
  });
});

describe('multi_edit field names', () => {
  it('accepts the names models use for old and new text', () => {
    const n = multiEditTool.normalize?.({
      path: 'a.ts',
      edits: [
        { search: 'a', replace: 'b' },
        { old_string: 'c', new_string: 'd' },
        { oldText: 'e', newText: 'f' },
      ],
    }) as { edits: { old_str: string; new_str: string }[] };
    expect(n.edits).toEqual([
      { old_str: 'a', new_str: 'b' },
      { old_str: 'c', new_str: 'd' },
      { old_str: 'e', new_str: 'f' },
    ]);
  });
});
