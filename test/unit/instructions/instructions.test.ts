import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN } from '../../../src/core/tokens.js';
import {
  INSTRUCTIONS_MAX_TOKENS,
  loadInstructions,
  renderInstructions,
} from '../../../src/instructions/load.js';
import { tempDir } from '../../support/tmp.js';

/** A repo with every instruction file type, plus nested AGENTS/CLAUDE under src/. */
async function fixtureRepo(): Promise<string> {
  const root = await tempDir();
  await writeFile(join(root, 'OMNEXX.md'), 'OMNEXX: prefer small modules.\n');
  await writeFile(join(root, 'AGENTS.md'), 'AGENTS: run the tests before committing.\n');
  await writeFile(join(root, 'CLAUDE.md'), 'CLAUDE: keep pull requests small.\n');
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(root, '.cursor', 'rules', 'style.mdc'),
    '---\ndescription: house style\n---\nUse single quotes everywhere.\n',
  );
  await writeFile(join(root, '.cursor', 'rules', 'naming.mdc'), 'Name new files in snake_case.\n');
  await mkdir(join(root, '.github'), { recursive: true });
  await writeFile(join(root, '.github', 'copilot-instructions.md'), 'Copilot: no inline TODOs.\n');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await writeFile(join(root, 'src', 'AGENTS.md'), 'AGENTS(src): keep modules dependency-free.\n');
  await writeFile(join(root, 'src', 'deep', 'CLAUDE.md'), 'CLAUDE(deep): no default exports.\n');
  return root;
}

const ROOT_FILES = [
  'OMNEXX.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursor/rules/naming.mdc',
  '.cursor/rules/style.mdc',
  '.github/copilot-instructions.md',
];

/** Assert that each needle appears in `render` after the previous one. */
function inOrder(render: string, ...needles: string[]): void {
  let at = -1;
  for (const needle of needles) {
    const next = render.indexOf(needle);
    expect(next, `expected "${needle}" in the render`).toBeGreaterThan(at);
    at = next;
  }
}

describe('project instructions', () => {
  it('renders nothing when the repo has no instruction files (zero-arg form included)', async () => {
    const root = await tempDir();
    const loaded = await loadInstructions(root, root);
    expect(loaded.files).toEqual([]);
    expect(renderInstructions(loaded)).toBe('');
    expect(renderInstructions()).toBe('');
  });

  it('loads every file type in precedence order and strips .mdc frontmatter', async () => {
    const root = await fixtureRepo();
    const loaded = await loadInstructions(root, root);
    expect(loaded.files.map((f) => f.path)).toEqual(ROOT_FILES);
    const render = renderInstructions(loaded);
    inOrder(
      render,
      'OMNEXX: prefer small modules.',
      'AGENTS: run the tests before committing.',
      'CLAUDE: keep pull requests small.',
      'Name new files in snake_case.',
      'Use single quotes everywhere.',
      'Copilot: no inline TODOs.',
    );
    expect(render).not.toContain('description: house style');
    expect(render).not.toContain('src/AGENTS.md');
    expect(render.startsWith('# Project instructions')).toBe(true);
    expect(loaded.truncated).toEqual([]);
  });

  it('adds nested AGENTS/CLAUDE for parent dirs of the cwd, shallow first', async () => {
    const root = await fixtureRepo();
    const loaded = await loadInstructions(root, join(root, 'src', 'deep'));
    expect(loaded.files.map((f) => f.path)).toEqual([
      ...ROOT_FILES,
      'src/AGENTS.md',
      'src/deep/CLAUDE.md',
    ]);
    inOrder(
      renderInstructions(loaded),
      'Copilot: no inline TODOs.',
      'AGENTS(src): keep modules dependency-free.',
      'CLAUDE(deep): no default exports.',
    );
  });

  it('ignores nested files when the cwd is outside the repo', async () => {
    const root = await fixtureRepo();
    const outside = await tempDir();
    const loaded = await loadInstructions(root, outside);
    expect(loaded.files.map((f) => f.path)).toEqual(ROOT_FILES);
  });

  it('skips empty instruction files', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'AGENTS.md'), '   \n');
    await writeFile(join(root, 'OMNEXX.md'), '');
    expect((await loadInstructions(root, root)).files).toEqual([]);
  });

  it('renders byte-stable output for the same repo', async () => {
    const root = await fixtureRepo();
    const a = renderInstructions(await loadInstructions(root, join(root, 'src')));
    const b = renderInstructions(await loadInstructions(root, join(root, 'src')));
    expect(a).toBe(b);
    expect(renderInstructions()).toBe(a);
  });

  it('cuts lowest precedence first under the 8k-token cap and notes every cut', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'OMNEXX.md'), `${'A'.repeat(15_000)}\n`);
    await writeFile(join(root, 'AGENTS.md'), `${'B'.repeat(6_000)}\n`);
    await writeFile(join(root, 'CLAUDE.md'), `${'C'.repeat(4_000)}\n`);
    await mkdir(join(root, '.github'), { recursive: true });
    await writeFile(join(root, '.github', 'copilot-instructions.md'), `${'D'.repeat(2_000)}\n`);
    const loaded = await loadInstructions(root, root);
    expect(loaded.truncated).toEqual(['.github/copilot-instructions.md', 'CLAUDE.md']);
    const render = renderInstructions(loaded);
    expect(render.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_TOKENS * CHARS_PER_TOKEN);
    expect(render).toContain('A'.repeat(100));
    expect(render).toContain('B'.repeat(100));
    expect(render).not.toContain('D'.repeat(100));
    expect(render).toContain('truncated to fit');
    expect(render).toContain('.github/copilot-instructions.md');
  });

  it('truncates a single oversized file instead of dropping it', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'OMNEXX.md'), 'X'.repeat(30_000));
    const loaded = await loadInstructions(root, root);
    expect(loaded.truncated).toEqual(['OMNEXX.md']);
    const render = renderInstructions(loaded);
    expect(render.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_TOKENS * CHARS_PER_TOKEN);
    expect(render).toContain('… (truncated)');
    expect(render).toContain('X'.repeat(50));
  });
});
