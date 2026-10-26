import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import {
  applyMigration,
  detectAgentConfigs,
  planMigration,
  runMigrate,
  toModelRef,
} from '../../../src/cli/migrate.js';
import { EXIT } from '../../../src/cli/exit-codes.js';
import { tempDir } from '../../support/tmp.js';

function ioFor(
  env: NodeJS.ProcessEnv,
  cwd: string,
  isTTY = false,
): { io: CliIO; out: () => string } {
  let stdout = '';
  const io: CliIO = {
    stdout: {
      write: (s: string) => {
        stdout += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    stdin: new PassThrough(),
    env,
    cwd,
    isTTY,
  };
  return { io, out: () => stdout };
}

interface Fixture {
  root: string;
  home: string;
  configHome: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIO;
  out: () => string;
}

async function setupFixture(opts: { projectConfig?: boolean } = {}): Promise<Fixture> {
  const root = await tempDir('migrate-');
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  const cwd = join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(configHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    OMNEXX_CONFIG_HOME: configHome,
    OMNEXX_HOME: join(root, 'state'),
  };
  if (opts.projectConfig) await writeFile(join(cwd, 'omnexx.toml'), '# project\n');
  const { io, out } = ioFor(env, cwd);
  return { root, home, configHome, cwd, env, io, out };
}

async function writeClaudeUser(home: string): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      env: { ANTHROPIC_API_KEY: 'sk-ant-fake', CI: '1' },
      permissions: { deny: ['rm -rf /'], allow: ['Bash(npm run *)'] },
      hooks: {
        PreToolUse: [
          {
            matchers: [{ toolName: 'Bash' }],
            hooks: [{ type: 'pre_tool', command: 'echo guard' }],
          },
        ],
        PreCommit: [{ matchers: [], hooks: [{ type: 'pre_commit', command: 'npm test' }] }],
        Notification: [
          { matchers: [], hooks: [{ type: 'notification', command: 'osascript -e beep' }] },
        ],
      },
    }),
  );
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_secret' },
        },
      },
    }),
  );
}

async function writeCursorUser(home: string): Promise<void> {
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    }),
  );
}

async function writeProjectCursor(cwd: string): Promise<void> {
  await mkdir(join(cwd, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(cwd, '.cursor', 'rules', 'style.mdc'), 'always use tokens\n');
  await writeFile(
    join(cwd, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        // Same name as the user-level one; the plan should keep the first occurrence.
        github: { command: 'npx', args: ['-y', 'server-github'] },
      },
    }),
  );
}

describe('toModelRef', () => {
  it('maps Claude Code aliases and full model ids to the anthropic provider', () => {
    expect(toModelRef('opus')).toBe('anthropic:opus');
    expect(toModelRef('Sonnet')).toBe('anthropic:sonnet');
    expect(toModelRef('claude-3-5-sonnet-latest')).toBe('anthropic:claude-3-5-sonnet-latest');
    expect(toModelRef('anthropic:sonnet')).toBe('anthropic:sonnet');
    expect(toModelRef('openrouter:anthropic/claude-opus-5.5')).toBe(
      'openrouter:anthropic/claude-opus-5.5',
    );
  });

  it('leaves models with an unknown provider to a note', () => {
    expect(toModelRef('gpt-4o')).toBeUndefined();
    expect(toModelRef('')).toBeUndefined();
  });
});

describe('detectAgentConfigs', () => {
  it('finds nothing on a clean machine', async () => {
    const f = await setupFixture();
    const detections = await detectAgentConfigs(f.io);
    expect(detections).toHaveLength(4);
    for (const d of detections) {
      expect(d.detected).toBe(false);
      expect(d.paths).toEqual([]);
      expect(d.servers).toEqual([]);
      expect(d.settings).toBeUndefined();
    }
  });

  it('detects claude-code and cursor configs, user and project', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    await writeCursorUser(f.home);
    await writeProjectCursor(f.cwd);
    await mkdir(join(f.cwd, '.claude'), { recursive: true });
    await writeFile(join(f.cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }));

    const d = await detectAgentConfigs(f.io);
    const byKey = Object.fromEntries(d.map((x) => [`${x.tool}:${x.scope}`, x]));

    const ccUser = byKey['claude-code:user'];
    expect(ccUser?.detected).toBe(true);
    expect(ccUser?.settings?.model).toBe('opus');
    expect(ccUser?.settings?.envNames).toEqual(['ANTHROPIC_API_KEY', 'CI']);
    expect(ccUser?.settings?.deny).toEqual(['rm -rf /']);
    expect(ccUser?.settings?.hooks).toHaveLength(2);
    expect(ccUser?.settings?.hooks[0]).toEqual({
      on: 'pre_tool',
      run: 'echo guard',
      match: 'Bash',
    });
    expect(ccUser?.settings?.hooks[1]).toEqual({ on: 'pre_commit', run: 'npm test' });
    expect(ccUser?.settings?.skippedHooks).toBe(1);
    expect(ccUser?.servers.map((s) => s.name)).toEqual(['github']);
    expect(ccUser?.servers[0]?.env).toEqual({ GITHUB_TOKEN: 'ghp_secret' });

    const ccProj = byKey['claude-code:project'];
    expect(ccProj?.detected).toBe(true);
    expect(ccProj?.settings?.model).toBe('sonnet');
    expect(ccProj?.servers).toEqual([]);

    const curUser = byKey['cursor:user'];
    expect(curUser?.detected).toBe(true);
    expect(curUser?.servers.map((s) => s.name)).toEqual(['filesystem']);

    const curProj = byKey['cursor:project'];
    expect(curProj?.detected).toBe(true);
    expect(curProj?.paths.some((p) => p.endsWith('rules'))).toBe(true);
    expect(curProj?.servers.map((s) => s.name)).toEqual(['github']);
  });
});

describe('planMigration', () => {
  it('plans items into the user config when there is no project config', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    await writeCursorUser(f.home);
    const detections = await detectAgentConfigs(f.io);
    const plan = await planMigration(detections, f.io);

    const userConfig = join(f.configHome, 'config.toml');
    expect(plan.items.length).toBeGreaterThan(0);
    for (const item of plan.items) expect(item.file).toBe(userConfig);
    expect(plan.files).toEqual([userConfig]);

    const kinds = plan.items.map((i) => i.kind);
    expect(kinds).toContain('server');
    expect(kinds).toContain('model');
    expect(kinds).toContain('policy-env');
    expect(kinds).toContain('policy-deny');
    expect(kinds).toContain('hook');

    const servers = plan.items.filter((i) => i.kind === 'server');
    expect(servers.map((s) => s.server?.name)).toEqual(['github', 'filesystem']);
    const model = plan.items.find((i) => i.kind === 'model');
    expect(model?.modelRef).toBe('anthropic:opus');
  });

  it('sends project-scope items to an existing omnexx.toml, and dedupes server names', async () => {
    const f = await setupFixture({ projectConfig: true });
    await writeClaudeUser(f.home);
    await writeProjectCursor(f.cwd);
    // A project-level setting so there is something non-duplicate to send to omnexx.toml.
    await mkdir(join(f.cwd, '.claude'), { recursive: true });
    await writeFile(join(f.cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    const detections = await detectAgentConfigs(f.io);
    const plan = await planMigration(detections, f.io);

    const projConfig = join(f.cwd, 'omnexx.toml');
    const userConfig = join(f.configHome, 'config.toml');
    const projItems = plan.items.filter((i) => i.file === projConfig);
    expect(projItems.length).toBeGreaterThan(0);
    for (const item of projItems) expect(item.scope).toBe('project');

    // "github" exists at user level (claude) and project level (cursor): first one wins.
    const servers = plan.items.filter((i) => i.kind === 'server');
    expect(servers).toHaveLength(1);
    expect(servers[0]?.server?.name).toBe('github');
    expect(servers[0]?.file).toBe(userConfig);
  });
});

describe('applyMigration', () => {
  it('writes servers, secrets, model, policy and hooks; re-running adds nothing twice', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    await writeCursorUser(f.home);
    const plan = await planMigration(await detectAgentConfigs(f.io), f.io);

    const lines1 = await applyMigration(plan, f.io);
    const userConfig = join(f.configHome, 'config.toml');
    expect(lines1.some((l) => l.includes('github'))).toBe(true);

    const text1 = await readFile(userConfig, 'utf8');
    const parsed1 = parseToml(text1) as {
      mcp?: { servers?: Record<string, { command: string; env: Record<string, string> }> };
      models?: { worker: string };
      policy?: { env_passthrough: string[]; deny: string[] };
      hooks?: { on: string; run: string; match?: string }[];
    };
    expect(parsed1.mcp?.servers?.github?.command).toBe('npx');
    expect(parsed1.mcp?.servers?.github?.env).toEqual({ GITHUB_TOKEN: 'secret:GITHUB_TOKEN' });
    expect(parsed1.mcp?.servers?.filesystem?.command).toBe('npx');
    expect(parsed1.models?.worker).toBe('anthropic:opus');
    expect(parsed1.policy?.env_passthrough).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CI']),
    );
    expect(parsed1.policy?.deny).toContain('rm -rf /');
    expect(parsed1.hooks).toHaveLength(2);
    expect(parsed1.hooks?.[0]).toMatchObject({ on: 'pre_tool', run: 'echo guard', match: 'Bash' });

    const secrets = JSON.parse(
      await readFile(join(f.configHome, 'mcp-secrets.json'), 'utf8'),
    ) as Record<string, Record<string, string>>;
    expect(secrets.github?.GITHUB_TOKEN).toBe('ghp_secret');

    // Second run: hooks and policy arrays stay deduped.
    await applyMigration(plan, f.io);
    const text2 = await readFile(userConfig, 'utf8');
    const parsed2 = parseToml(text2) as {
      policy?: { env_passthrough: string[]; deny: string[] };
      hooks?: unknown[];
    };
    expect(parsed2.hooks).toHaveLength(2);
    expect(parsed2.policy?.env_passthrough).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CI']),
    );
    expect(new Set(parsed2.policy?.env_passthrough).size).toBe(
      parsed2.policy?.env_passthrough.length,
    );
    expect(new Set(parsed2.policy?.deny).size).toBe(parsed2.policy?.deny.length);
  });

  it('applies only the selected items', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    const plan = await planMigration(await detectAgentConfigs(f.io), f.io);
    const server = plan.items.find((i) => i.kind === 'server');
    expect(server).toBeDefined();
    const lines = await applyMigration(plan, f.io, [server?.id ?? '']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/MCP server/);
    const text = await readFile(join(f.configHome, 'config.toml'), 'utf8');
    const parsed = parseToml(text) as { mcp?: { servers?: Record<string, unknown> } };
    expect(Object.keys(parsed.mcp?.servers ?? {})).toEqual(['github']);
  });
});

describe('unknown-field preservation', () => {
  it('keeps unrecognized claude-code settings under [raw.claude-code.user]', async () => {
    const f = await setupFixture();
    await mkdir(join(f.home, '.claude'), { recursive: true });
    await writeFile(
      join(f.home, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        include: ['**/*.md'],
        permissions: { deny: ['rm -rf /'], allow: ['Bash(npm run *)'] },
        someUnknown: { nested: true, arr: [1, 2] },
      }),
    );
    const plan = await planMigration(await detectAgentConfigs(f.io), f.io);
    expect(plan.items.some((i) => i.kind === 'raw')).toBe(true);
    await applyMigration(plan, f.io);
    const text = await readFile(join(f.configHome, 'config.toml'), 'utf8');
    const parsed = parseToml(text) as { raw?: Record<string, Record<string, unknown>> };
    const user = parsed.raw?.['claude-code']?.user;
    expect(user).toBeDefined();
    expect(user).toMatchObject({
      include: ['**/*.md'],
      permissions: { allow: ['Bash(npm run *)'] },
      someUnknown: { nested: true, arr: [1, 2] },
    });
  });
});

describe('runMigrate', () => {
  it('prints the plan as JSON with --json and writes nothing', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    const code = await runMigrate(f.io, { json: true });
    expect(code).toBe(EXIT.ok);
    const json = JSON.parse(f.out()) as {
      detections: { tool: string; detected: boolean }[];
      items: { kind: string }[];
    };
    expect(json.detections.some((d) => d.tool === 'claude-code' && d.detected)).toBe(true);
    expect(json.items.some((i) => i.kind === 'server')).toBe(true);
    await expect(readFile(join(f.configHome, 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('applies the whole plan with --yes on a non-TTY', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    const code = await runMigrate(f.io, { yes: true });
    expect(code).toBe(EXIT.ok);
    expect(f.out()).toContain('✓ MCP server "github"');
    const text = await readFile(join(f.configHome, 'config.toml'), 'utf8');
    expect(text).toContain('[mcp.servers.github]');
  });

  it('prints a report and no changes without a terminal', async () => {
    const f = await setupFixture();
    await writeClaudeUser(f.home);
    const code = await runMigrate(f.io, {});
    expect(code).toBe(EXIT.ok);
    expect(f.out()).toContain('detected');
    expect(f.out()).toContain('Run this on a terminal');
    await expect(readFile(join(f.configHome, 'config.toml'), 'utf8')).rejects.toThrow();
  });
});
