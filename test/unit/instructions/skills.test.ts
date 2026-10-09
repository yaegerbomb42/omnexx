import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/tokens.js';
import {
  listSkills,
  listSkillsWithSource,
  loadSkill,
  skillDirs,
  SKILL_MAX_TOKENS,
} from '../../../src/instructions/skills.js';
import { skillCatalog } from '../../../src/tools/extra/skill.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const SKILL = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

async function roots(): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const repoRoot = await tempDir();
  await mkdir(join(repoRoot, '.omnexx', 'skills', 'commit-style'), { recursive: true });
  await writeFile(
    join(repoRoot, '.omnexx', 'skills', 'commit-style', 'SKILL.md'),
    SKILL('commit-style', 'How omnexx commits are written', 'Use conventional commits.\n'),
  );
  await mkdir(join(repoRoot, '.omnexx', 'skills', 'plain'), { recursive: true });
  await writeFile(
    join(repoRoot, '.omnexx', 'skills', 'plain', 'SKILL.md'),
    'No frontmatter body.\n',
  );
  const env = await isolatedEnv();
  const configHome = String(env.OMNEXX_CONFIG_HOME);
  await mkdir(join(configHome, 'skills', 'review'), { recursive: true });
  await writeFile(
    join(configHome, 'skills', 'review', 'SKILL.md'),
    SKILL('review', 'How to review a PR', 'Review checklist.\n'),
  );
  // Shadowed by the repo skill with the same name.
  await mkdir(join(configHome, 'skills', 'commit-style'), { recursive: true });
  await writeFile(
    join(configHome, 'skills', 'commit-style', 'SKILL.md'),
    SKILL('commit-style', 'user copy', 'User style.\n'),
  );
  return { repoRoot, env };
}

describe('skills discovery', () => {
  it('lists repo and user skills sorted by name, repo wins on duplicates', async () => {
    const { repoRoot, env } = await roots();
    expect(await listSkills({ repoRoot, env })).toEqual([
      { name: 'commit-style', description: 'How omnexx commits are written' },
      { name: 'plain', description: '' },
      { name: 'review', description: 'How to review a PR' },
    ]);
  });

  it('falls back to the directory name when the frontmatter has no name', async () => {
    const { repoRoot, env } = await roots();
    const skill = await loadSkill('plain', { repoRoot, env });
    expect(skill?.name).toBe('plain');
    expect(skill?.description).toBe('');
  });

  it('returns the body without frontmatter and the source path', async () => {
    const { repoRoot, env } = await roots();
    const skill = await loadSkill('commit-style', { repoRoot, env });
    expect(skill?.body).toContain('Use conventional commits.');
    expect(skill?.body).not.toContain('description:');
    expect(skill?.path).toContain(join('.omnexx', 'skills', 'commit-style', 'SKILL.md'));
  });

  it('returns undefined for an unknown skill', async () => {
    const { repoRoot, env } = await roots();
    expect(await loadSkill('nope', { repoRoot, env })).toBeUndefined();
  });

  it('reads user skills without a repo root', async () => {
    const { env } = await roots();
    const names = (await listSkills({ env })).map((s) => s.name);
    expect(names).toEqual(['commit-style', 'review']);
  });

  it('caps the body at 6k tokens with a truncation note', async () => {
    const { repoRoot, env } = await roots();
    const dir = join(repoRoot, '.omnexx', 'skills', 'long');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), SKILL('long', 'Long skill', 'L'.repeat(19_000)));
    const skill = await loadSkill('long', { repoRoot, env });
    expect(skill?.truncated).toBe(true);
    expect(skill?.body.endsWith('… (truncated)')).toBe(true);
    expect(estimateTokens(String(skill?.body))).toBeLessThanOrEqual(SKILL_MAX_TOKENS);
  });

  it('is byte-stable across scans', async () => {
    const { repoRoot, env } = await roots();
    expect(await listSkills({ repoRoot, env })).toEqual(await listSkills({ repoRoot, env }));
  });
});

describe('skills from Claude Code and extra folders', () => {
  async function setup() {
    const { repoRoot, env } = await roots();
    const home = await tempDir('omnexx-fakehome-');
    const put = async (dir: string, name: string, description: string) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, 'SKILL.md'), SKILL(name, description, `${name} body`));
    };
    await put(join(home, '.claude', 'skills'), 'research', 'Claude user skill');
    await put(join(home, '.claude', 'skills'), 'review', 'Claude copy, shadowed by omnexx user');
    await put(join(repoRoot, '.claude', 'skills'), 'repo-claude', 'Claude repo skill');
    const extra = await tempDir('omnexx-extra-');
    await put(extra, 'extra-one', 'From [skills] dirs');
    return { repoRoot, env: { ...env, HOME: home }, extra };
  }

  it('reads Claude Code skills and extra dirs in place, omnexx folders shadow them', async () => {
    const { repoRoot, env, extra } = await setup();
    const all = await listSkillsWithSource({ repoRoot, env, dirs: [extra], importClaude: true });
    const by = Object.fromEntries(all.map((s) => [s.name, s.source]));
    expect(by).toMatchObject({
      research: 'claude-user',
      'repo-claude': 'claude-repo',
      'extra-one': 'config',
      review: 'user',
      'commit-style': 'repo',
    });
  });

  it('leaves Claude Code skills out when import is off, and expands ~ in dirs', async () => {
    const { repoRoot, env } = await setup();
    const names = (await listSkills({ repoRoot, env, importClaude: false })).map((s) => s.name);
    expect(names).not.toContain('research');
    const dirs = skillDirs({ env, dirs: ['~/x'] });
    expect(dirs.find((d) => d.source === 'config')?.dir).toBe(join(env.HOME, 'x'));
  });

  it('the skill tool lists what exists, cut to a budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `s${i}`,
      description: 'd'.repeat(100),
    }));
    const catalog = skillCatalog(many);
    expect(catalog.length).toBeLessThan(6_200);
    expect(catalog).toMatch(/more \(call with a name to load one\)$/);
    expect(skillCatalog([{ name: 'a', description: 'one\nline' }])).toBe('- a: one line');
  });
});

describe('symlinked skills', () => {
  it('follows a symlinked skill folder and ignores a dangling one', async () => {
    const { symlink } = await import('node:fs/promises');
    const env = await isolatedEnv();
    const real = await tempDir('omnexx-real-skill-');
    await mkdir(join(real, 'linked'), { recursive: true });
    await writeFile(join(real, 'linked', 'SKILL.md'), SKILL('linked', 'via a link', 'Body'));
    const skills = join(String(env.OMNEXX_CONFIG_HOME), 'skills');
    await mkdir(skills, { recursive: true });
    await symlink(join(real, 'linked'), join(skills, 'linked'));
    await symlink(join(real, 'missing'), join(skills, 'dangling'));
    expect(await listSkills({ env })).toEqual([{ name: 'linked', description: 'via a link' }]);
  });
});
