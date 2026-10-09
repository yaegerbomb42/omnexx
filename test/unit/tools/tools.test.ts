import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../../src/core/events.js';
import { bashTool, readLogTool, trimOutput } from '../../../src/tools/bash.js';
import { multiEditTool, strReplaceTool, writeFileTool } from '../../../src/tools/edit.js';
import { extractSymbols, outlineTool } from '../../../src/tools/outline.js';
import { readTool } from '../../../src/tools/read.js';
import { READ_ONLY_TOOLS, sortKeys, toolSpec, WORKER_TOOLS } from '../../../src/tools/registry.js';
import { rememberTool } from '../../../src/tools/remember.js';
import { _internal, searchTool } from '../../../src/tools/search.js';
import { secretCorpus } from '../../support/secrets.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

async function repo(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src/a.ts'),
    'export function add(a: number, b: number) {\n  return a + b;\n}\nexport const PI = 3;\n',
  );
  await writeFile(
    join(root, 'src/big.ts'),
    Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join('\n'),
  );
  await writeFile(join(root, '.env'), `KEY=${secretCorpus().anthropic}\n`);
  return root;
}

describe('read / outline', () => {
  it('reads with line numbers and ranges; large files need a range', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    expect((await readTool.run({ path: 'src/a.ts' }, ctx)).content).toContain(
      '    2    return a + b;',
    );
    const big = await readTool.run({ path: 'src/big.ts' }, ctx);
    expect(big.content).toMatch(/has 500 lines; read it by range/);
    const range = await readTool.run({ path: 'src/big.ts', start: 10, end: 2000 }, ctx);
    expect(range.content.split('\n')[0]).toContain('v9');
    expect(range.content).toContain('(lines 410-500 not shown)');
    expect((await readTool.run({ path: 'src/a.ts', start: 99 }, ctx)).isError).toBe(true);
    expect((await readTool.run({ path: '.env' }, ctx)).content).toMatch(/denied/);
    expect((await readTool.run({ path: 'nope.ts' }, ctx)).content).toMatch(/ENOENT/);
    await writeFile(join(root, 'bin.dat'), 'a\0b');
    expect((await readTool.run({ path: 'bin.dat' }, ctx)).content).toMatch(/binary/);
  });

  it('extracts symbols across languages', () => {
    const syms = extractSymbols(
      [
        'export async function go() {}',
        'class Foo {',
        '  bar(x: number): void {',
        '  if (x) {',
        'export interface I {}',
        'export type T = 1;',
        'def py_fn(x):',
        'func (s *S) GoFn() {',
        'pub fn rusty() {}',
        'export enum E {}',
      ].join('\n'),
    );
    expect(syms.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'function:go',
      'class:Foo',
      'method:bar',
      'interface:I',
      'type:T',
      'def:py_fn',
      'func:GoFn',
      'item:rusty',
      'enum:E',
    ]);
  });

  it('outline tool', async () => {
    const ctx = await toolContext(await repo());
    expect((await outlineTool.run({ path: 'src/a.ts' }, ctx)).content).toContain('function add');
    expect((await outlineTool.run({ path: '../x' }, ctx)).isError).toBe(true);
  });
});

describe('search', () => {
  it('finds matches with context, never in secret files; JS fallback agrees', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    const r = await searchTool.run({ pattern: 'return a' }, ctx);
    expect(r.content).toContain('src/a.ts:2:');
    expect((await searchTool.run({ pattern: 'sk-ant' }, ctx)).content).toBe('no matches');
    expect((await searchTool.run({ pattern: 'v\\d\\d', glob: 'src/*.ts' }, ctx)).content).toMatch(
      /more matches not shown/,
    );
    expect((await searchTool.run({ pattern: '(' }, ctx)).content).toMatch(/invalid regex/);
    expect((await searchTool.run({ pattern: 'x', path: '..' }, ctx)).isError).toBe(true);
    const js = await _internal.viaJs('return a', root, undefined);
    expect(js).toEqual(['src/a.ts:2:  return a + b;']);
    expect(await _internal.viaJs('KEY', root, '**/*.ts')).toEqual([]);
  });
});

describe('edit tools', () => {
  it('str_replace requires a unique match and writes nothing otherwise', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    expect(
      (await strReplaceTool.run({ path: 'src/a.ts', old_str: 'a + b', new_str: 'a - b' }, ctx))
        .isError,
    ).toBeUndefined();
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain('a - b');
    expect([...ctx.edited]).toEqual(['src/a.ts']);
    expect(
      (await strReplaceTool.run({ path: 'src/a.ts', old_str: 'a', new_str: 'z' }, ctx)).content,
    ).toMatch(/found \d+ times/);
    expect(
      (await strReplaceTool.run({ path: 'src/none.ts', old_str: 'a', new_str: 'z' }, ctx)).content,
    ).toMatch(/write_file/);
    expect(
      (await strReplaceTool.run({ path: '../a.ts', old_str: 'a', new_str: 'z' }, ctx)).content,
    ).toMatch(/outside/);
  });

  it('multi_edit is all-or-nothing; $ patterns in new_str are literal', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    const before = await readFile(join(root, 'src/a.ts'), 'utf8');
    const bad = await multiEditTool.run(
      {
        path: 'src/a.ts',
        edits: [
          { old_str: 'PI = 3', new_str: 'PI = 4' },
          { old_str: 'missing', new_str: 'x' },
        ],
      },
      ctx,
    );
    expect(bad.content).toMatch(/edit 2/);
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe(before);
    await multiEditTool.run(
      { path: 'src/a.ts', edits: [{ old_str: 'PI = 3', new_str: "PI = '$&$1'" }] },
      ctx,
    );
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toContain("PI = '$&$1'");
  });

  it('write_file creates files and directories, refuses to overwrite big files', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    expect(
      (await writeFileTool.run({ path: 'new/dir/x.ts', content: 'x\n' }, ctx)).content,
    ).toMatch(/wrote/);
    expect((await writeFileTool.run({ path: 'src/big.ts', content: '' }, ctx)).content).toMatch(
      /more than 50 lines/,
    );
    expect((await writeFileTool.run({ path: '.env.local', content: '' }, ctx)).isError).toBe(true);
  });
});

describe('bash + read_log', () => {
  it('runs allowed commands in the root with a scrubbed env and redacted, trimmed output', async () => {
    const root = await repo();
    const secret = secretCorpus().github;
    const ctx = await toolContext(root);
    const r = await bashTool.run({ command: `echo hi; echo ${secret}; ls src` }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/^\[exit 0, \d+ms, log cmd-1-1\]/);
    expect(r.content).toContain('a.ts');
    expect(r.content).not.toContain(secret);
    expect(await readFile(join(ctx.store.logsDir, 'cmd-1-1.log'), 'utf8')).not.toContain(secret);
    expect((await bashTool.run({ command: 'exit 2' }, ctx)).isError).toBe(true);
    expect((await bashTool.run({ command: 'sleep 5', timeout: '200ms' }, ctx)).content).toMatch(
      /timed out/,
    );
    expect((await bashTool.run({ command: 'true', timeout: 'soon' }, ctx)).content).toMatch(
      /invalid timeout/,
    );
    // Models often send milliseconds as a bare number (or a numeric string).
    expect((await bashTool.run({ command: 'sleep 5', timeout: '200' }, ctx)).content).toMatch(
      /timed out/,
    );
    const parsed = bashTool.schema.parse(
      bashTool.normalize?.({ command: 'true', timeout: 120000 }),
    );
    expect(parsed.timeout).toBe('120000');
  });

  it('refuses policy violations, logs tool.denied, and calls the safety hook only for allowed commands', async () => {
    const root = await repo();
    const seen: string[] = [];
    const ctx = await toolContext(root, { onBash: (c) => seen.push(c) });
    for (const cmd of [
      'cat ~/.ssh/id_ed25519',
      'rm -rf ../',
      'git push --force',
      'echo $ANTHROPIC_API_KEY',
      'echo x > /tmp/elsewhere.txt',
    ]) {
      const r = await bashTool.run({ command: cmd }, ctx);
      expect(r.isError, cmd).toBe(true);
      expect(r.content).toMatch(/refused by policy/);
    }
    await bashTool.run({ command: 'true' }, ctx);
    expect(seen).toEqual(['true']);
    const events = await readEvents(ctx.store.eventsPath);
    expect(events.filter((e) => e.type === 'tool.denied')).toHaveLength(5);
  });

  it('trims long output and read_log pages through the full log', async () => {
    const root = await repo();
    const ctx = await toolContext(root);
    const r = await bashTool.run(
      { command: 'for i in $(seq 1 1000); do echo line$i; done; echo "Error: boom"' },
      ctx,
    );
    expect(r.content).toBe(r.content);
    const sub = await bashTool.run({ command: 'seq 1 1000' }, ctx);
    expect(sub.content).toMatch(/lines omitted \(read_log id="cmd-1-\d"/);
    const id = /log (cmd-1-\d)/.exec(sub.content)?.[1] ?? '';
    const page = await readLogTool.run({ id, start: 500, end: 501 }, ctx);
    expect(page.content).toContain('   500  500');
    expect((await readLogTool.run({ id: 'cmd-9-9' }, ctx)).isError).toBe(true);
    expect(trimOutput('a\nb', 'x')).toBe('a\nb');
    const t = trimOutput(
      [
        ...Array.from({ length: 200 }, (_, i) => `l${i}`),
        'Error: mid',
        ...Array.from({ length: 200 }, (_, i) => `m${i}`),
      ].join('\n'),
      'cmd-x',
    );
    expect(t).toContain('Error: mid');
    expect(t.split('\n').length).toBeLessThan(160);
    const long = trimOutput(`ok\n${'z'.repeat(5_000)}`, 'cmd-y');
    expect(long.length).toBeLessThan(600);
    expect(long).toContain('[5000 chars]');
  });
});

describe('remember', () => {
  it('writes notes for the next cycle and logs the update', async () => {
    const ctx = await toolContext(await repo());
    expect(
      (await rememberTool.run({ action: 'add', type: 'command', text: 'use pnpm' }, ctx)).content,
    ).toMatch(/next cycle/);
    expect((await ctx.store.readNotes())[0]).toMatchObject({
      id: 'N1',
      text: 'use pnpm',
      date: '2026-10-03',
    });
    expect((await rememberTool.run({ action: 'remove', id: 'N7' }, ctx)).isError).toBe(true);
  });
});

describe('registry', () => {
  it('specs are deterministic with sorted keys; read-only subset excludes writers', () => {
    const a = JSON.stringify(WORKER_TOOLS.map(toolSpec));
    const b = JSON.stringify(WORKER_TOOLS.map(toolSpec));
    expect(a).toBe(b);
    expect(a).not.toContain('$schema');
    expect(READ_ONLY_TOOLS.map((t) => t.name).sort()).toEqual([
      'outline',
      'read',
      'read_log',
      'recall',
      'remember',
      'running_context',
      'search',
      'task',
    ]);
    expect(JSON.stringify(sortKeys({ b: 1, a: [{ d: 1, c: 2 }] }))).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    );
  });
});

describe('tool schemas the API accepts', () => {
  it('every tool spec is a plain object schema at the top level (no top-level union)', () => {
    for (const spec of WORKER_TOOLS.map(toolSpec)) {
      expect(spec.inputSchema.type, spec.name).toBe('object');
      for (const k of ['oneOf', 'anyOf', 'allOf'])
        expect(spec.inputSchema, `${spec.name}.${k}`).not.toHaveProperty(k);
    }
  });

  it('remember enforces per-action fields', async () => {
    const ctx = await toolContext(await repo());
    expect((await rememberTool.run({ action: 'add', text: 'no type' }, ctx)).content).toMatch(
      /add needs type and text/,
    );
    expect((await rememberTool.run({ action: 'remove' }, ctx)).isError).toBe(true);
  });
});
