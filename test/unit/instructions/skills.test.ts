import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/tokens.js';
import { listSkills, loadSkill, SKILL_MAX_TOKENS } from '../../../src/instructions/skills.js';
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
