import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineTag, locateRange } from '../../../src/tools/anchors.js';
import { strReplaceTool } from '../../../src/tools/edit.js';
import { readTool } from '../../../src/tools/read.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

const FILE = [
  'function ship(order) {',
  '    const total = price + tax;',
  '    return total;',
  '}',
  '',
  'function other(order) {',
  '    const total = price;',
  '    return 0;',
  '}',
  '',
];

async function repo(name: string, text: string) {
  const root = await tempDir();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, name), text);
  return { root, ctx: await toolContext(root) };
}

function anchoredRows(content: string): string[] {
  return content.split('\n').filter((l) => /^\s*\d+ [a-z2-9]{2} /.test(l));
}

describe('str_replace miss recovery', () => {
  it('returns the real lines and a replace_lines hash when indentation is not the only drift', async () => {
    const text = FILE.join('\n');
    const { root, ctx } = await repo('src/f.txt', text);
    const old = [
      'function ship(order) {',
      '  const total = price + taxx;',
      '  return total;',
      '}',
    ].join('\n');
    const r = await strReplaceTool.run({ path: 'src/f.txt', old_str: old, new_str: 'nope' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.miss).toBe(true);
    expect(r.content.startsWith('miss: true\n')).toBe(true);
    expect(r.content).toMatch(/did not match/);
    expect(r.content).toMatch(/replace_lines can use expected_hash/);
    expect(await readFile(join(root, 'src/f.txt'), 'utf8')).toBe(text);

    const lines = text.split('\n');
    const where = /Closest lines are (\d+)-(\d+)/.exec(r.content);
    const hash = /expected_hash ([a-z2-9]{4})/.exec(r.content);
    expect(where).not.toBeNull();
    expect(hash).not.toBeNull();
    const start = Number(where?.[1]);
    const end = Number(where?.[2]);
    expect(locateRange(lines, start, end, hash?.[1])).toEqual({
      ok: true,
      start,
      end,
      moved: false,
    });
    expect(r.content).toContain('    const total = price + tax;');
    for (let n = start; n <= end; n++) {
      expect(r.content).toContain(`${String(n).padStart(5)} ${lineTag(lines[n - 1] ?? '')} `);
    }
    const shown = await readTool.run({ path: 'src/f.txt', start, end, anchors: true }, ctx);
    for (const row of anchoredRows(shown.content)) expect(r.content).toContain(row);
  });

  it('a unique whitespace match still edits; an exact match still edits', async () => {
    const text = FILE.join('\n');
    const { root, ctx } = await repo('src/f.txt', text);
    const loose = await strReplaceTool.run(
      {
        path: 'src/f.txt',
        old_str: [
          'function ship(order) {',
          '  const total = price + tax;',
          '  return total;',
          '}',
        ].join('\n'),
        new_str: 'function ship(order) {\n  return 1;\n}',
      },
      ctx,
    );
    expect(loose.miss).toBeUndefined();
    expect(loose.isError).toBeUndefined();
    expect(loose.content).toMatch(/ignoring whitespace/);
    const afterLoose = await readFile(join(root, 'src/f.txt'), 'utf8');
    expect(afterLoose).toContain('return 1;');
    const exact = await strReplaceTool.run(
      { path: 'src/f.txt', old_str: '    return 0;', new_str: '    return 2;' },
      ctx,
    );
    expect(exact.miss).toBeUndefined();
    expect(exact.isError).toBeUndefined();
    expect(await readFile(join(root, 'src/f.txt'), 'utf8')).toContain('    return 2;');
  });

  it('keeps the ambiguous-match error and does not guess', async () => {
    const { root, ctx } = await repo('src/f.txt', 'same\nsame\n');
    const r = await strReplaceTool.run({ path: 'src/f.txt', old_str: 'same', new_str: 'x' }, ctx);
    expect(r.miss).toBeUndefined();
    expect(r.content).toMatch(/found 2 times/);
    expect(r.content).not.toMatch(/expected_hash/);
    expect(await readFile(join(root, 'src/f.txt'), 'utf8')).toBe('same\nsame\n');
  });

  it('an unrelated old_str returns a short snippet, not the whole file', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `row ${i} ${'abc'.repeat(10)}`);
    const text = lines.join('\n');
    const { ctx } = await repo('src/f.txt', text);
    const old = ['zzzz unrelated one', 'zzzz unrelated two', 'zzzz unrelated three'].join('\n');
    const r = await strReplaceTool.run({ path: 'src/f.txt', old_str: old, new_str: 'nope' }, ctx);
    const rows = anchoredRows(r.content);
    expect(r.miss).toBe(true);
    expect(rows.length).toBe(3);
    expect(rows.length).toBeLessThan(lines.length);
    expect(r.content).not.toContain('row 79');
    const longNeedle = Array.from({ length: 50 }, (_, i) => `nope ${i} qqqq`).join('\n');
    const capped = await strReplaceTool.run(
      { path: 'src/f.txt', old_str: longNeedle, new_str: 'nope' },
      ctx,
    );
    expect(anchoredRows(capped.content).length).toBe(40);
  });

  it('does not format a miss, and still formats a successful edit', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    const bin = join(root, 'node_modules/.bin/prettier');
    await writeFile(bin, '#!/bin/sh\nfor f; do :; done\necho "// formatted" >> "$f"\n');
    await chmod(bin, 0o755);
    await writeFile(join(root, '.prettierrc'), '{}');
    await writeFile(join(root, 'a.md'), 'hello\n');
    const ctx = await toolContext(root);
    const miss = await strReplaceTool.run(
      { path: 'a.md', old_str: 'no such words zzz', new_str: 'x' },
      ctx,
    );
    expect(miss.miss).toBe(true);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('hello\n');
    const hit = await strReplaceTool.run({ path: 'a.md', old_str: 'hello', new_str: 'world' }, ctx);
    expect(hit.miss).toBeUndefined();
    expect(hit.content).toMatch(/Formatted with prettier/);
    expect(await readFile(join(root, 'a.md'), 'utf8')).toContain('// formatted');
  });
});
