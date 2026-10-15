import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { handleSkills } from '../../../src/cli/chat-skills.js';
import { registerMarket } from '../../../src/cli/commands/skills-market.js';
import type { CliIO } from '../../../src/cli/io.js';
import { listSkills } from '../../../src/instructions/skills.js';
import { readSkillsState } from '../../../src/instructions/skills-state.js';
import {
  parseRepoRef,
  safeRelativePath,
  type FetchLike,
} from '../../../src/integrations/skills-github.js';
import {
  addMarketplace,
  catalog,
  filterSkills,
  installMarketSkill,
  updateMarketSkills,
  type MarketDeps,
} from '../../../src/integrations/skills-market.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

/** A fake GitHub: repos as {path: content}, with tree shas that change with the content. */
function fakeGitHub(repos: Record<string, Record<string, string>>) {
  const calls: string[] = [];
  const sha = (s: string) => String(s.length * 31 + (s.codePointAt(0) ?? 0));
  const fetchFn: FetchLike = (url) => {
    calls.push(url);
    const respond = (status: number, body = '') =>
      Promise.resolve({
        ok: status === 200,
        status,
        text: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
      });
    const tree = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees/.exec(url);
    if (tree) {
      const files = repos[tree[1] ?? ''];
      if (!files) return respond(404);
      const dirs = new Set(
        Object.keys(files).flatMap((p) =>
          p
            .split('/')
            .slice(0, -1)
            .map((_, i, a) => a.slice(0, i + 1).join('/')),
        ),
      );
      const dirSha = (d: string) =>
        sha(
          Object.entries(files)
            .filter(([p]) => p.startsWith(`${d}/`))
            .map(([, c]) => c)
            .join(),
        );
      const entries = [
        ...[...dirs].map((d) => ({ path: d, type: 'tree', sha: dirSha(d) })),
        ...Object.entries(files).map(([p, c]) => ({
          path: p,
          type: 'blob',
          sha: sha(c),
          size: c.length,
        })),
      ];
      return respond(200, JSON.stringify({ sha: 'root', tree: entries }));
    }
    const raw = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/(.+)$/.exec(url);
    const body = raw ? repos[raw[1] ?? '']?.[decodeURIComponent(raw[2] ?? '')] : undefined;
    return body === undefined ? respond(404) : respond(200, body);
  };
  return { fetchFn, calls };
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nDo the ${name} thing.\n`;

const REPOS = {
  'anthropics/skills': {
    'skills/pdf/SKILL.md': skillMd('pdf', 'Read and fill PDF forms'),
    'skills/pdf/scripts/fill.py': 'print("never run")',
    'skills/docx/SKILL.md': skillMd('docx', 'Edit Word documents'),
    'README.md': '# skills',
  },
  'acme/market': {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'acme',
      plugins: [
        { name: 'local', source: './' },
        { name: 'remote', source: { source: 'github', repo: 'acme/linked' } },
      ],
    }),
    'skills/lint/SKILL.md': skillMd('lint', 'Lint all the things'),
  },
  'acme/linked': { 'SKILL.md': skillMd('linked-skill', 'From a linked repo') },
};

async function setup() {
  const env = await isolatedEnv({ HOME: await tempDir('omnexx-home-') });
  const gh = fakeGitHub(structuredClone(REPOS));
  let now = 1_000;
  const deps: MarketDeps = { env, fetch: gh.fetchFn, now: () => now };
  const userDir = join(await tempDir('omnexx-user-skills-'), 'skills');
  return { env, gh, deps, userDir, tick: (ms: number) => (now += ms) };
}

describe('GitHub refs and paths', () => {
  it('accepts owner/repo and github URLs, refuses anything else', () => {
    expect(parseRepoRef('anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills' });
    expect(parseRepoRef('https://github.com/acme/market.git')).toEqual({
      owner: 'acme',
      repo: 'market',
    });
    expect(parseRepoRef('github.com/acme/market/tree/main')).toMatchObject({ repo: 'market' });
    expect(() => parseRepoRef('https://gitlab.com/a/b')).toThrow(/not a GitHub repo/);
    expect(() => parseRepoRef('a/b/c')).toThrow(/not a GitHub repo/);
  });

  it('only writes plain relative paths', () => {
    expect(safeRelativePath('scripts/fill.py')).toBe(true);
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', '.git/config', 'a//b', ''])
      expect(safeRelativePath(bad)).toBe(false);
  });
});

describe('skill marketplaces', () => {
  it("lists Anthropic's skills by default with their files, and caches the catalog", async () => {
    const { deps, gh, tick } = await setup();
    const { skills, errors } = await catalog(deps);
    expect(errors).toEqual([]);
    expect(skills.map((s) => s.id).sort()).toEqual([
      'anthropics/skills:skills/docx',
      'anthropics/skills:skills/pdf',
    ]);
    const pdf = skills.find((s) => s.name === 'pdf');
    expect(pdf?.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'scripts/fill.py']);
    expect(pdf?.description).toBe('Read and fill PDF forms');

    const before = gh.calls.length;
    await catalog(deps);
    expect(gh.calls.length).toBe(before);
    tick(25 * 60 * 60 * 1000);
    await catalog(deps);
    expect(gh.calls.length).toBeGreaterThan(before);
  });

  it('adds a marketplace by URL and follows repos its marketplace.json links to', async () => {
    const { deps, env } = await setup();
    expect(await addMarketplace('https://github.com/acme/market', deps)).toBe(
      'acme/market (2 skills)',
    );
    expect((await readSkillsState(env)).marketplaces).toEqual(['acme/market']);
    const { skills } = await catalog(deps);
    expect(filterSkills(skills, 'linked').map((s) => s.id)).toEqual(['acme/linked:.']);
    expect(filterSkills(skills, 'lint things').map((s) => s.name)).toEqual(['lint']);
    await expect(addMarketplace('nobody/here', deps)).rejects.toThrow(/404/);
    expect((await readSkillsState(env)).marketplaces).toEqual(['acme/market']);
  });

  it('reports a marketplace it cannot read instead of failing', async () => {
    const { deps } = await setup();
    const broken: MarketDeps = {
      ...deps,
      fetch: () => Promise.reject(new Error('offline')),
    };
    const { skills, errors } = await catalog(broken);
    expect(skills).toEqual([]);
    expect(errors).toEqual(['anthropics/skills: offline']);
  });

  it('installs files only, records the source, and updates when upstream changes', async () => {
    const { deps, env, userDir, gh } = await setup();
    const { skills } = await catalog(deps);
    const pdf = skills.find((s) => s.name === 'pdf');
    if (!pdf) throw new Error('missing pdf');
    expect(await installMarketSkill(pdf, userDir, deps)).toBe('pdf');
    expect(await readFile(join(userDir, 'pdf', 'scripts', 'fill.py'), 'utf8')).toBe(
      'print("never run")',
    );
    expect((await readSkillsState(env)).installed.pdf?.id).toBe('anthropics/skills:skills/pdf');
    await expect(installMarketSkill(pdf, userDir, deps)).rejects.toThrow(/already installed/);

    expect(await updateMarketSkills(userDir, deps)).toEqual({ updated: [], missing: [] });
    const changed = fakeGitHub({
      ...REPOS,
      'anthropics/skills': {
        ...REPOS['anthropics/skills'],
        'skills/pdf/SKILL.md': skillMd('pdf', 'Read, fill and sign PDF forms'),
      },
    });
    const r = await updateMarketSkills(userDir, { ...deps, fetch: changed.fetchFn });
    expect(r.updated).toEqual(['pdf']);
    expect(await readFile(join(userDir, 'pdf', 'SKILL.md'), 'utf8')).toContain('sign');
    expect(gh.calls.every((u) => !u.includes('..'))).toBe(true);
  });
});

describe('skills for the editor and the CLI', () => {
  async function io() {
    // A home of its own, so the real ~/.claude/skills stays out of the list.
    const env = await isolatedEnv({ HOME: await tempDir('omnexx-home-') });
    const cwd = await tempDir('omnexx-skills-repo-');
    const gh = fakeGitHub(structuredClone(REPOS));
    let out = '';
    let err = '';
    const cliIo: CliIO = {
      stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream,
      stderr: { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WriteStream,
      stdin: process.stdin,
      cwd,
      isTTY: false,
      env,
      fetch: ((url: string) => gh.fetchFn(url)) as unknown as typeof fetch,
    };
    return { cliIo, env, cwd, out: () => out, err: () => err };
  }

  it('searches, previews, installs, toggles and removes through the chat-server commands', async () => {
    const { cliIo, env, cwd } = await io();
    const market = (await handleSkills(cliIo, { type: 'skillsSearch', query: 'pdf' })) as {
      skills: { id: string }[];
    };
    expect(market.skills.map((s) => s.id)).toEqual(['anthropics/skills:skills/pdf']);
    const preview = (await handleSkills(cliIo, {
      type: 'skillsPreview',
      id: 'anthropics/skills:skills/pdf',
    })) as { text: string; skill: { files: unknown[] } };
    expect(preview.text).toContain('Do the pdf thing');
    expect(preview.skill.files).toHaveLength(2);

    const installed = (await handleSkills(cliIo, {
      type: 'skillsInstall',
      id: 'anthropics/skills:skills/pdf',
    })) as { installed: { name: string; enabled: boolean; tokens: number; from?: string }[] };
    const row = installed.installed.find((s) => s.name === 'pdf');
    expect(row).toMatchObject({ enabled: true, from: 'anthropics/skills:skills/pdf' });
    expect(row?.tokens).toBeGreaterThan(0);

    await handleSkills(cliIo, { type: 'skillsToggle', name: 'pdf', on: false });
    expect(await listSkills({ repoRoot: cwd, env, disabled: ['pdf'] })).toEqual([]);
    expect((await readSkillsState(env)).disabled).toEqual(['pdf']);

    const removed = (await handleSkills(cliIo, { type: 'skillsRemove', name: 'pdf' })) as {
      installed: unknown[];
    };
    expect(removed.installed).toEqual([]);
    expect((await readSkillsState(env)).installed).toEqual({});
  });

  it('omnexx skills search / info / install / disable / market', async () => {
    const { cliIo, out, err } = await io();
    let code = 0;
    const run = async (...args: string[]) => {
      const program = new Command().exitOverride();
      const cmd = program.command('skills');
      registerMarket(cmd, cliIo, (c) => (code = c));
      await program.parseAsync(['node', 'omnexx', 'skills', ...args]);
    };
    await run('search', 'word');
    expect(out()).toContain('anthropics/skills:skills/docx');
    await run('info', 'pdf');
    expect(out()).toMatch(/scripts\/fill\.py/);
    await run('install', 'pdf');
    expect(out()).toMatch(/Installed pdf[\s\S]*never run automatically/);
    await run('disable', 'pdf');
    expect(out()).toContain('pdf is off');
    await run('market', 'add', 'acme/market');
    expect(out()).toContain('Added marketplace acme/market (2 skills)');
    await run('market');
    expect(out()).toMatch(/anthropics\/skills\nacme\/market/);
    expect(code).toBe(0);
    await run('install', 'nope');
    expect(err()).toMatch(/no marketplace skill "nope"/);
    expect(code).toBe(1);
  });
});
