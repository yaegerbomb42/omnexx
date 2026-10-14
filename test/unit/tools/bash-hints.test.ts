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
