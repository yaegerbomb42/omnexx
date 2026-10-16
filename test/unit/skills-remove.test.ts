import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleSkills } from '../../src/cli/chat-skills.js';
import type { CliIO } from '../../src/cli/io.js';
import {
  EMPTY_SKILLS_STATE,
  forgetSkill,
  readSkillsState,
  setSkillHidden,
} from '../../src/instructions/skills-state.js';
import { listHtml, removeMessage, skillFolder } from '../../vscode/src/webview/skillsList.js';
import { isolatedEnv, tempDir } from '../support/tmp.js';

interface Row {
  name: string;
  enabled: boolean;
  hidden: boolean;
  owned: boolean;
  path: string;
}

async function setup() {
  const env = await isolatedEnv({ HOME: await tempDir('omnexx-home-') });
  const cwd = await tempDir('omnexx-skills-repo-');
  const folder = join(cwd, '.claude', 'skills', 'deploy');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'SKILL.md'),
    '---\nname: deploy\ndescription: Our release steps\n---\nDo it.\n',
  );
  const io = { cwd, env, isTTY: false } as unknown as CliIO;
  const rows = async (): Promise<Row[]> =>
    ((await handleSkills(io, { type: 'skills' })) as { installed: Row[] }).installed;
  return { io, env, folder, rows };
}

describe('skills state: hide and forget', () => {
  it('hiding switches a skill off; bringing it back keeps it off; nothing is mutated', () => {
    const hidden = setSkillHidden(EMPTY_SKILLS_STATE, 'a', true);
    expect(hidden).toMatchObject({ hidden: ['a'], disabled: ['a'] });
    expect(EMPTY_SKILLS_STATE.hidden).toEqual([]);
    expect(setSkillHidden(hidden, 'a', false)).toMatchObject({ hidden: [], disabled: ['a'] });
    expect(forgetSkill(hidden, 'a')).toMatchObject({ hidden: [], disabled: [] });
  });
});

describe('removing skills from any source', () => {
  it('hides a repo skill without touching its files, then brings it back off', async () => {
    const { io, env, folder, rows } = await setup();
    expect(await rows()).toMatchObject([{ name: 'deploy', owned: false, hidden: false }]);
    await handleSkills(io, { type: 'skillsRemove', name: 'deploy', mode: 'hide' });
    expect(await rows()).toMatchObject([{ name: 'deploy', hidden: true, enabled: false }]);
    expect((await stat(join(folder, 'SKILL.md'))).isFile()).toBe(true);
    await handleSkills(io, { type: 'skillsUnhide', name: 'deploy' });
    expect(await rows()).toMatchObject([{ hidden: false, enabled: false }]);
    expect((await readSkillsState(env)).hidden).toEqual([]);
  });

  it('deletes the folder only when the confirmed path matches', async () => {
    const { io, folder, rows } = await setup();
    await expect(
      handleSkills(io, { type: 'skillsRemove', name: 'deploy', mode: 'delete', path: '/tmp' }),
    ).rejects.toThrow(/confirm the folder/);
    const [row] = await rows();
    if (!row) throw new Error('no row');
    const msg = removeMessage(
      { ...row, description: '', sourceLabel: 'repo .claude', tokens: 0 },
      'delete',
    );
    expect(msg).toEqual({ type: 'skillsRemove', name: 'deploy', mode: 'delete', path: folder });
    const after = (await handleSkills(io, msg as { type: string })) as { notice: string };
    expect(after.notice).toBe(`deleted ${folder}`);
    expect(await rows()).toEqual([]);
    await expect(stat(folder)).rejects.toThrow();
  });

  it('the CLI remove still refuses skills omnexx does not own', async () => {
    const { io } = await setup();
    await expect(handleSkills(io, { type: 'skillsRemove', name: 'deploy' })).rejects.toThrow(
      /comes from repo .claude/,
    );
  });
});

describe('settings skills list', () => {
  const skill = {
    name: 'pdf',
    description: 'PDFs',
    path: '/home/me/.claude/skills/pdf/SKILL.md',
    sourceLabel: 'Claude Code',
    enabled: true,
    owned: false,
    tokens: 20,
  };

  it('gives every skill a switch and Remove, and names the folder when confirming', () => {
    const closed = listHtml([skill], { showHidden: false });
    expect(closed).toContain('data-sk-toggle="pdf" checked');
    expect(closed).toContain('data-sk-remove="pdf"');
    expect(closed).not.toContain('data-sk-delete');
    const open = listHtml([skill], { showHidden: false, confirming: 'pdf' });
    expect(open).toContain('data-sk-hide="pdf"');
    expect(open).toContain('<code>/home/me/.claude/skills/pdf</code>');
    expect(skillFolder(skill.path)).toBe('/home/me/.claude/skills/pdf');
    expect(removeMessage(skill, 'hide')).toEqual({
      type: 'skillsRemove',
      name: 'pdf',
      mode: 'hide',
    });
  });

  it('folds hidden skills away and shows an empty state with an action', () => {
    const html = listHtml([{ ...skill, hidden: true, enabled: false }], { showHidden: false });
    expect(html).toContain('No skills yet');
    expect(html).toContain('data-sk-browse');
    expect(html).toContain('1 hidden from omnexx');
    expect(html).not.toContain('data-sk-unhide');
    expect(listHtml([{ ...skill, hidden: true }], { showHidden: true })).toContain(
      'data-sk-unhide="pdf"',
    );
  });
});
