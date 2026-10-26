import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type * as NodePath from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleSkills, installedSkills } from '../../src/cli/chat-skills.js';
import type { CliIO } from '../../src/cli/io.js';
import { readSkillsState, skillsStateFile } from '../../src/instructions/skills-state.js';
import type * as SkillsModule from '../../src/instructions/skills.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';

const WINDOWS_SKILL_PATH = vi.hoisted(() => 'C:\\Users\\test\\skills\\my-marketplace\\SKILL.md');
const WINDOWS_SKILL_FOLDER = vi.hoisted(() => 'C:\\Users\\test\\skills\\my-marketplace');

// On Linux, node:path splits on '/' only, so a backslash path collapses into one long segment
// (the very bug these tests guard against). Make dirname/basename treat '\' as a separator too —
// exactly what the real functions do on Windows — so the paths below exercise the Windows code
// path on any host.
vi.mock('node:path', async (importOriginal) => {
  const real = await importOriginal<typeof NodePath>();
  const windowsLike = (p: string): boolean => p.includes('\\');
  return {
    ...real,
    dirname: (p: string): string =>
      windowsLike(p) ? p.replace(/[\\/][^\\/]*$/, '') : real.dirname(p),
    basename: (p: string): string =>
      windowsLike(p) ? (p.split(/[\\/]/).filter(Boolean).at(-1) ?? '') : real.basename(p),
  };
});

// The filesystem scan builds POSIX paths, so inject a single Windows-style skill directly.
vi.mock('../../src/instructions/skills.js', async (importOriginal) => {
  const real = await importOriginal<typeof SkillsModule>();
  return {
    ...real,
    listSkillsWithSource: () => [
      {
        name: 'deploy',
        description: 'Deploy steps',
        path: WINDOWS_SKILL_PATH,
        source: 'user',
      },
    ],
  };
});

async function setupWindowsEnv() {
  const env = await isolatedEnv({ HOME: await tempDir('omnexx-windows-home-') });
  const cwd = await tempDir('omnexx-windows-repo-');
  await mkdir(dirname(skillsStateFile(env)), { recursive: true });
  await writeFile(
    skillsStateFile(env),
    JSON.stringify({
      disabled: [],
      hidden: [],
      marketplaces: [],
      installed: {
        'my-marketplace': {
          id: 'acme/deploy',
          sha: 'abc123',
          installedAt: '2026-10-25T00:00:00.000Z',
        },
      },
    }),
  );
  const io = { cwd, env, isTTY: false } as unknown as CliIO;
  return { env, io };
}

describe('chat skills with Windows-style paths', () => {
  it('installedSkills derives the marketplace key from the folder name', async () => {
    const { io } = await setupWindowsEnv();
    const rows = await installedSkills(io);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe('acme/deploy');
  });

  it('removeSkill forgets the marketplace by folder name', async () => {
    const { env, io } = await setupWindowsEnv();
    await handleSkills(io, { type: 'skillsRemove', name: 'deploy' });
    expect((await readSkillsState(env)).installed).toEqual({});
  });

  it('deleteSkillFiles confirms the folder and forgets it by name', async () => {
    const { env, io } = await setupWindowsEnv();
    await handleSkills(io, {
      type: 'skillsRemove',
      name: 'deploy',
      mode: 'delete',
      path: WINDOWS_SKILL_FOLDER,
    });
    expect((await readSkillsState(env)).installed).toEqual({});
  });
});
