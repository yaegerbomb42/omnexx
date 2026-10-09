import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEvents } from '../../../src/core/events.js';
import { readSecrets } from '../../../src/integrations/secrets.js';
import {
  integrationsInstallTool,
  integrationsSearchTool,
} from '../../../src/tools/extra/integrations.js';
import { GITHUB, PLAYWRIGHT } from '../../support/registry-fixtures.js';
import { tempDir } from '../../support/tmp.js';
import { toolContext } from '../../support/tool-context.js';

async function setup() {
  const base = await tempDir('omnexx-integrations-');
  const configHome = join(base, 'config');
  const repoRoot = join(base, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const places = {
    configFile: join(configHome, 'config.toml'),
    configHome,
    cacheFile: join(configHome, 'cache', 'mcp-registry.json'),
    repoRoot,
    env: { HOME: join(base, 'home'), OMNEXX_CONFIG_HOME: configHome },
  };
  const fetchFn = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ servers: [{ server: PLAYWRIGHT }, { server: GITHUB }] })),
    )) as unknown as typeof fetch;
  return { places, fetchFn, repoRoot, configHome };
}

const configText = (file: string) => readFile(file, 'utf8').catch(() => '');

describe('integrations tools', () => {
  it('in chat: asks the person, installs on yes, and does nothing on no', async () => {
    const { places, fetchFn, repoRoot } = await setup();
    const questions: string[] = [];
    const tool = integrationsInstallTool(places, false, fetchFn);

    const no = await toolContext(repoRoot, {
      ask: (q) => (questions.push(q), Promise.resolve(false)),
    });
    expect((await tool.run({ kind: 'mcp', name: 'playwright' }, no)).isError).toBe(true);
    expect(await configText(places.configFile)).toBe('');
    expect(questions[0]).toContain('io.github.microsoft/playwright-mcp');
    expect(questions[0]).toContain('(known publisher)');
    expect(questions[0]).toMatch(/\[y\/N\]$/);

    const yes = await toolContext(repoRoot, { ask: () => Promise.resolve(true) });
    const r = await tool.run({ kind: 'mcp', name: 'playwright' }, yes);
    expect(r.content).toContain('Installed io.github.microsoft/playwright-mcp as "playwright-mcp"');
    expect(await configText(places.configFile)).toContain('[mcp.servers.playwright-mcp]');
  });

  it('unattended: suggests instead of installing, unless auto_approve is on', async () => {
    const { places, fetchFn, repoRoot } = await setup();
    const ctx = await toolContext(repoRoot);
    const r = await integrationsInstallTool(places, false, fetchFn).run(
      { kind: 'mcp', name: 'playwright' },
      ctx,
    );
    expect(r.content).toMatch(/Not installed \(unattended run\)/);
    expect(await configText(places.configFile)).toBe('');
    const events = await readEvents(ctx.store.eventsPath);
    expect(events.find((e) => e.type === 'integration.suggested')).toMatchObject({
      kind: 'mcp',
      server: 'io.github.microsoft/playwright-mcp',
      trusted: true,
    });

    const auto = await integrationsInstallTool(places, true, fetchFn).run(
      { kind: 'mcp', name: 'playwright' },
      await toolContext(repoRoot),
    );
    expect(auto.content).toContain('Installed');
  });

  it('asks for required settings before anything, and stores them as secrets', async () => {
    const { places, fetchFn, repoRoot, configHome } = await setup();
    const tool = integrationsInstallTool(places, true, fetchFn);
    const ctx = await toolContext(repoRoot);
    const missing = await tool.run(
      { kind: 'mcp', name: 'github', pick: 'io.github.github/github-mcp-server' },
      ctx,
    );
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/needs Authorization/);
    const done = await tool.run(
      {
        kind: 'mcp',
        name: 'github',
        pick: 'io.github.github/github-mcp-server',
        settings: { Authorization: 'ghp_x' },
      },
      ctx,
    );
    expect(done.content).toContain('as "github-mcp-server"');
    expect(await configText(places.configFile)).not.toContain('ghp_x');
    expect(await readSecrets(configHome)).toEqual({
      'github-mcp-server': { Authorization: 'Bearer ghp_x' },
    });
  });

  it('adds skills from a path, and searches the registry and the local skills', async () => {
    const { places, fetchFn, repoRoot, configHome } = await setup();
    await mkdir(join(repoRoot, 'pack', 'tidy'), { recursive: true });
    await writeFile(
      join(repoRoot, 'pack', 'tidy', 'SKILL.md'),
      '---\nname: tidy\ndescription: Tidy imports\n---\nBody\n',
    );
    const ctx = await toolContext(repoRoot, { ask: () => Promise.resolve(true) });
    const added = await integrationsInstallTool(places, false, fetchFn).run(
      { kind: 'skill', name: 'pack' },
      ctx,
    );
    expect(added.content).toContain('Added tidy');
    expect(await readFile(join(configHome, 'skills', 'tidy', 'SKILL.md'), 'utf8')).toContain(
      'Tidy',
    );

    const search = integrationsSearchTool(places, fetchFn);
    expect((await search.run({ kind: 'skill', query: 'imports' }, ctx)).content).toContain('tidy');
    const mcp = await search.run({ kind: 'mcp', query: 'github' }, ctx);
    expect(mcp.content).toMatch(/^✓ io\.github\.(microsoft|github)/);
    expect(mcp.content).toContain('needs Authorization');
  });
});
