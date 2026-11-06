/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- test doubles */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityCatalog,
  createCatalogTools,
  syntheticCatalog,
} from '../../../src/runtime/kernel/catalog.js';
import {
  loadRegistry,
  fetchLiveRegistry,
  installSuggestion,
  MCP_REGISTRY_URL,
} from '../../../src/runtime/kernel/registry.js';
import {
  discoverLocalMcpServers,
  discoverLocalSkills,
  searchSkillMd,
} from '../../../src/runtime/kernel/discover.js';
import { AdaptiveRuntimeKernel } from '../../../src/runtime/kernel/kernel.js';
import type { Tool } from '../../../src/tools/types.js';
import { z } from 'zod';

function fakeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    schema: z.object({}),
    readOnly: true,
    run: async () => ({ content: '' }),
  } as unknown as Tool;
}

describe('CapabilityCatalog + synthetic 2k', () => {
  it('indexes and searches 2000 synthetic entries under 50ms', () => {
    const cat = new CapabilityCatalog();
    const entries = syntheticCatalog(2000);
    const t0 = performance.now();
    cat.load(entries);
    const loadMs = performance.now() - t0;
    expect(cat.size).toBe(2000);

    const t1 = performance.now();
    const hits = cat.search('create github issue pull request', 10);
    const searchMs = performance.now() - t1;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /github/i.test(h.name + h.description))).toBe(true);
    expect(loadMs).toBeLessThan(200);
    expect(searchMs).toBeLessThan(50);

    cat.select({ query: 'deploy k8s docker', maxMounted: 8 });
    expect(cat.getMountedIds().length).toBeLessThanOrEqual(8);
  });

  it('reselects on cadence / friction / new task', () => {
    const cat = new CapabilityCatalog();
    cat.load(syntheticCatalog(100));
    cat.select({ query: 'list slack channels', maxMounted: 4 });
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 0, newTask: false })).toBe(false);
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 0, newTask: false })).toBe(false);
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 0, newTask: false })).toBe(false);
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 0, newTask: false })).toBe(true); // 4th turn
    cat.select({ query: 'again', maxMounted: 4 });
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 2, newTask: false })).toBe(true);
    cat.select({ query: 'again2', maxMounted: 4 });
    expect(cat.shouldReselect({ everyNTurns: 4, frictionScore: 0, newTask: true })).toBe(true);
  });
});

describe('createCatalogTools install gate', () => {
  it('suggests install for registry ids instead of mounting', async () => {
    const cat = new CapabilityCatalog();
    cat.load([
      {
        id: 'registry:mcp:example/server',
        kind: 'mcp',
        name: 'example',
        description: 'Example registry server',
        server: 'example/server',
      },
      {
        id: 'local:mcp:github',
        kind: 'mcp',
        name: 'github',
        description: 'Local github MCP',
        server: 'github',
      },
    ]);
    const tools = createCatalogTools(cat, {
      maxMounted: 4,
      isInstalled: (id) => id.startsWith('local:'),
      suggestInstall: (id) => `INSTALL_HINT:${id}`,
    });
    const search = tools.find((t) => t.name === 'search_capabilities')!;
    const mount = tools.find((t) => t.name === 'mount_capability')!;

    const searched = await search.run({ query: 'github example', limit: 8 }, {} as never);
    expect(searched.isError).toBeFalsy();
    const body = JSON.parse(searched.content);
    expect(body.results.some((r: { id: string }) => r.id.startsWith('registry:'))).toBe(true);

    const blocked = await mount.run({ id: 'registry:mcp:example/server' }, {} as never);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('INSTALL_HINT:');

    const okMount = await mount.run({ id: 'local:mcp:github' }, {} as never);
    expect(okMount.isError).toBeFalsy();
    expect(cat.isMounted('local:mcp:github')).toBe(true);
  });
});

describe('MCP Registry (real)', () => {
  it('loads bundled snapshot offline with thousands of real servers', async () => {
    const result = await loadRegistry({
      offline: true,
      // Force miss on user cache so we exercise the committed snapshot path.
      env: { ...process.env, OMNEXX_CONFIG_HOME: '/tmp/omnexx-no-cache-' + String(process.pid) },
    });
    expect(result.from).toBe('bundled');
    expect(result.snapshot.servers.length).toBeGreaterThan(1000);
    expect(result.snapshot.source).toMatch(/mcp|registry/i);
    expect(result.entries[0]?.id).toMatch(/^registry:mcp:/);
    expect(result.entries.every((e) => e.kind === 'mcp')).toBe(true);

    const cat = new CapabilityCatalog();
    cat.load(result.entries);
    const hits = cat.search('filesystem read write local files', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('queries the live official registry and returns servers', async () => {
    const snap = await fetchLiveRegistry({ limit: 50, maxPages: 2 });
    expect(snap.source).toBe(MCP_REGISTRY_URL);
    expect(snap.rawCount).toBeGreaterThan(50);
    expect(snap.latestCount).toBeGreaterThan(10);
    expect(snap.servers[0]?.installable).toBe(true);
    const hint = installSuggestion(snap.servers[0]!);
    expect(hint.toLowerCase()).toMatch(/install|package|mcp|add/);
  }, 60_000);
});

describe('local discovery (real configs)', () => {
  it('discovers MCP servers from project .mcp.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omnexx-mcp-'));
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          custom_db: { command: 'node', args: ['db.js'], description: 'Custom DB tools' },
        },
      }),
    );
    const found = await discoverLocalMcpServers({
      repoRoot: root,
      env: { ...process.env, HOME: root },
    });
    expect(found.entries.map((e) => e.name).sort()).toEqual(['custom_db', 'filesystem']);
    expect(found.entries.every((e) => e.id.startsWith('local:mcp:'))).toBe(true);
    expect(found.sources.some((s) => s.includes('mcp.json'))).toBe(true);
  });

  it('discovers SKILL.md skills from a local skills dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omnexx-skills-'));
    const skillDir = join(root, '.cursor', 'skills', 'demo-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: demo-skill\ndescription: Demo skill for catalog discovery tests\n---\n\n# Demo\nDo the demo thing.\n`,
    );
    const found = await discoverLocalSkills({
      repoRoot: root,
      env: { ...process.env, HOME: root },
    });
    expect(found.entries.some((e) => e.name === 'demo-skill')).toBe(true);
    expect(found.entries.find((e) => e.name === 'demo-skill')?.kind).toBe('skill');
  });
});

describe('SkillMD public skills index (verified real)', () => {
  it('searches api.skillmd.com and returns skill headers', async () => {
    const hits = await searchSkillMd('pdf', { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toMatch(/^registry:skill:/);
    expect(hits[0]?.kind).toBe('skill');
  }, 20_000);
});

describe('AdaptiveRuntimeKernel catalog warm', () => {
  it('warms with offline registry + exposes catalog meta-tools', async () => {
    const kernel = new AdaptiveRuntimeKernel({
      enabled: true,
      ollamaUrl: 'http://127.0.0.1:9',
      ollamaModel: 'none',
      embedModel: 'none',
      attentionCeiling: 0.65,
      worktree: process.cwd(),
      maxWindow: 100_000,
      maxMounted: 6,
      reselectEvery: 2,
      registry: true,
      localDiscovery: true,
      publicSkills: false,
      offlineRegistry: true,
    });
    await kernel.warm([
      { name: 'read', description: 'read a file' },
      { name: 'bash', description: 'run a shell command' },
    ]);
    const plan = await kernel.planTurn({
      objective: 'read a local file and search for filesystem MCP servers',
      allTools: [fakeTool('read', 'read a file'), fakeTool('bash', 'run shell')],
      defaultMaxTokens: 4096,
    });
    const names = plan.tools.map((t) => t.name);
    expect(names).toContain('search_capabilities');
    expect(names).toContain('mount_capability');
  }, 30_000);
});
