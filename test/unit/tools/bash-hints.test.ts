import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDevServer, missingScriptHint } from '../../../src/tools/bash.js';
import { tempRepo } from '../../support/tmp.js';

describe('bash: dev servers and missing scripts', () => {
  it.each([
    ['npm run dev', true],
    ['cd apps/web && npm install && npm run dev', true],
    ['pnpm dev', true],
    ['npx vite', true],
    ['next dev -p 3000', true],
    ['npm run build', false],
    ['npm test', false],
    ['npx vite build', false],
    ['npm run lint', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isDevServer(cmd)).toBe(expected);
  });

  it('names the scripts that exist in the folder the command ran in', async () => {
    const root = await tempRepo();
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await writeFile(
      join(root, 'apps/web/package.json'),
      JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }),
    );
    const out = 'npm error Missing script: "test"';
    expect(await missingScriptHint(out, 'cd apps/web && npm test', root)).toContain(
      'scripts in apps/web/package.json: dev, build',
    );
    expect(await missingScriptHint('ok', 'npm test', root)).toBe('');
    expect(await missingScriptHint(out, 'cd ../elsewhere && npm test', root)).toBe('');
  });
});

describe('list', () => {
  it('lists folders and files, leaving out dependencies and secrets', async () => {
    const { listTree } = await import('../../../src/tools/list.js');
    const root = await tempRepo();
    await mkdir(join(root, 'src/pages'), { recursive: true });
    await mkdir(join(root, 'node_modules/x'), { recursive: true });
    await writeFile(join(root, 'src/pages/home.tsx'), '');
    await writeFile(join(root, 'node_modules/x/i.js'), '');
    await writeFile(join(root, '.env'), 'K=1');
    const out = await listTree(root, root, 3);
    expect(out.split('\n')).toEqual(['src/', 'src/pages/', 'src/pages/home.tsx']);
    expect(await listTree(root, root, 1)).toBe('src/');
  });
});

describe('forgiving tool input', () => {
  it('renames the argument names models use and drops extras', async () => {
    const { lenientInput } = await import('../../../src/agent/loop.js');
    const { readTool } = await import('../../../src/tools/read.js');
    const { searchTool } = await import('../../../src/tools/search.js');
    expect(
      lenientInput(readTool.schema, { path: 'src/main.js', line_start: 1, line_end: 400 }),
    ).toEqual({ path: 'src/main.js', start: 1, end: 400 });
    const s = lenientInput(searchTool.schema, {
      pattern: 'requestAnimationFrame',
      max_results: 50,
      depth: 2,
    });
    expect(searchTool.schema.safeParse(s).success).toBe(true);
    expect(lenientInput(readTool.schema, { path: 'a.ts' })).toBeUndefined();
  });
});

describe('ambiguous edits', () => {
  it('say where each copy of old_str is', async () => {
    const { strReplaceTool } = await import('../../../src/tools/edit.js');
    const { toolContext } = await import('../../support/tool-context.js');
    const root = await tempRepo();
    await writeFile(
      join(root, 'g.js'),
      'a\nrequestAnimationFrame(loop);\nb\nrequestAnimationFrame(loop);\n',
    );
    const ctx = await toolContext(root);
    const r = await strReplaceTool.run(
      { path: 'g.js', old_str: 'requestAnimationFrame(loop);', new_str: 'x' },
      ctx,
    );
    expect(r.content).toContain('at lines 2, 4');
  });
});
