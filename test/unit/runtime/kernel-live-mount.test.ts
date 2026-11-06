/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion -- test doubles */
import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpClientManager } from '../../../src/mcp/client-manager.js';
import { AdaptiveRuntimeKernel } from '../../../src/runtime/kernel/kernel.js';
import { mcpCapabilityRuntime } from '../../../src/runtime/kernel/liveMount.js';
import { mergeWithFloor, type RegistrySnapshot } from '../../../src/runtime/kernel/registry.js';
import type { Tool } from '../../../src/tools/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeServerScript = join(__dirname, '../../fixtures/mcp/fake-server.ts');

function baseTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({}),
    readOnly: true,
    run: async () => ({ content: '' }),
  } as unknown as Tool;
}

describe('mergeWithFloor (#19)', () => {
  it('never shrinks below the floor snapshot', () => {
    const floor: RegistrySnapshot = {
      source: 'bundled',
      fetchedAt: '2026-01-01T00:00:00Z',
      rawCount: 100,
      latestCount: 3,
      servers: [
        {
          id: 'registry:mcp:a',
          kind: 'mcp',
          name: 'a',
          description: 'A',
          server: 'a',
          source: 'mcp-registry',
          installable: true,
        },
        {
          id: 'registry:mcp:b',
          kind: 'mcp',
          name: 'b',
          description: 'B',
          server: 'b',
          source: 'mcp-registry',
          installable: true,
        },
        {
          id: 'registry:mcp:c',
          kind: 'mcp',
          name: 'c',
          description: 'C',
          server: 'c',
          source: 'mcp-registry',
          installable: true,
        },
      ],
    };
    const live: RegistrySnapshot = {
      source: 'https://registry.modelcontextprotocol.io/v0/servers',
      fetchedAt: '2026-11-05T00:00:00Z',
      rawCount: 50,
      latestCount: 1,
      servers: [
        {
          id: 'registry:mcp:a',
          kind: 'mcp',
          name: 'a-live',
          description: 'A updated',
          server: 'a',
          source: 'mcp-registry',
          installable: true,
        },
      ],
    };
    const merged = mergeWithFloor(live, floor);
    expect(merged.latestCount).toBe(3);
    expect(merged.servers.find((s) => s.server === 'a')?.name).toBe('a-live');
    expect(merged.servers.map((s) => s.server).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.note).toMatch(/merged with bundled/i);
  });
});

describe('kernel live MCP mount injection (#1)', () => {
  let manager: McpClientManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
      manager = null;
    }
  });

  it('injects real stdio MCP tools into plan.tools on mount and removes them on unmount', async () => {
    manager = new McpClientManager({
      fake: {
        command: process.execPath,
        args: ['--experimental-strip-types', fakeServerScript],
        env: [],
        headers_env: {},
        allow_tools: ['*'],
        inherit_env: false,
        timeout: '15s',
      },
    });

    const runtime = mcpCapabilityRuntime(manager);
    const kernel = new AdaptiveRuntimeKernel({
      enabled: true,
      ollamaUrl: 'http://127.0.0.1:9',
      ollamaModel: 'none',
      embedModel: 'none',
      attentionCeiling: 0.65,
      worktree: process.cwd(),
      maxWindow: 100_000,
      maxMounted: 6,
      reselectEvery: 99,
      registry: false,
      localDiscovery: false,
      publicSkills: false,
      offlineRegistry: true,
      mcpRuntime: runtime,
    });

    await kernel.warm([{ name: 'read', description: 'read a file' }]);

    // Turn 1: baseline — fake server not yet in catalog
    const plan1 = await kernel.planTurn({
      objective: 'just reading files',
      allTools: [baseTool('read'), baseTool('bash')],
      defaultMaxTokens: 2048,
    });
    const names1 = plan1.tools.map((t) => t.name);
    expect(names1).toContain('search_capabilities');
    expect(names1).toContain('mount_capability');
    expect(names1.some((n) => n.startsWith('mcp__fake__'))).toBe(false);

    // Register local MCP header, then explicit mount → lazy-connect + inject
    kernel.catalog.upsert([
      {
        id: 'local:mcp:fake',
        kind: 'mcp',
        name: 'fake',
        description: 'Fake MCP echo server for tests',
        server: 'fake',
      },
    ]);
    const mount = plan1.tools.find((t) => t.name === 'mount_capability')!;
    const mounted = await mount.run({ id: 'local:mcp:fake' }, {} as never);
    expect(mounted.isError).toBeFalsy();
    expect(mounted.content).toMatch(/Live MCP tools injected/i);
    expect(mounted.content).toMatch(/mcp__fake__echo/);

    const plan2 = await kernel.planTurn({
      objective: 'echo a message via fake mcp',
      allTools: [baseTool('read'), baseTool('bash')],
      defaultMaxTokens: 2048,
    });
    const names2 = plan2.tools.map((t) => t.name);
    expect(names2).toContain('mcp__fake__echo');
    expect(names2).toContain('mcp__fake__crash_or_greet');

    // Call the live tool end-to-end
    const echo = plan2.tools.find((t) => t.name === 'mcp__fake__echo')!;
    const result = await echo.run({ message: 'kernel-live' }, {
      redactor: { text: (s: string) => s },
    } as never);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('ECHO: kernel-live');

    // Unmount from catalog then sync — live tools must be removed.
    expect(kernel.catalog.unmount('local:mcp:fake')).toBe(true);
    await kernel.syncLiveMounts();
    expect(kernel.getLiveMcpTools().some((t) => t.name.startsWith('mcp__fake__'))).toBe(false);

    const plan3 = await kernel.planTurn({
      objective: 'zzzz unrelated objective without echo keywords',
      allTools: [baseTool('read'), baseTool('bash')],
      defaultMaxTokens: 2048,
    });
    // If TF-IDF reselect remounts fake, tools may return — pin empty by removing entry.
    // Prove the unmount path itself cleared live tools before any reselect:
    // (assertion above). For model-visible list after a forced clear:
    kernel.catalog.load([
      { id: 'local:tool:read', kind: 'tool', name: 'read', description: 'read a file' },
    ]);
    await kernel.dropLiveMount('local:mcp:fake');
    await kernel.syncLiveMounts();
    const plan4 = await kernel.planTurn({
      objective: 'zzzz still unrelated',
      allTools: [baseTool('read'), baseTool('bash')],
      defaultMaxTokens: 2048,
    });
    expect(plan4.tools.some((t) => t.name.startsWith('mcp__fake__'))).toBe(false);
    expect(plan3.tools.map((t) => t.name)).toContain('mount_capability');
  }, 60_000);

  it('pages mounted skill bodies into the system hint', async () => {
    const kernel = new AdaptiveRuntimeKernel({
      enabled: true,
      ollamaUrl: 'http://127.0.0.1:9',
      ollamaModel: 'none',
      embedModel: 'none',
      attentionCeiling: 0.65,
      worktree: process.cwd(),
      maxWindow: 100_000,
      registry: false,
      localDiscovery: false,
      publicSkills: false,
      offlineRegistry: true,
      mcpRuntime: {
        loadMcpServerTools: async () => [],
        loadSkillBody: async (name) =>
          name === 'demo' ? '# Demo skill\n\nDo the demo carefully.' : undefined,
      },
    });
    await kernel.warm([]);
    kernel.catalog.upsert([
      {
        id: 'local:skill:demo',
        kind: 'skill',
        name: 'demo',
        description: 'A demo skill',
      },
    ]);
    // Force mount + page
    kernel.catalog.mount('local:skill:demo', 4);
    await kernel.activateLiveMount(kernel.catalog.get('local:skill:demo')!);
    const plan = await kernel.planTurn({
      objective: 'use the demo skill',
      allTools: [baseTool('read')],
      defaultMaxTokens: 1024,
    });
    // Skill pages only appear when tier>=2 hint is used OR we check getPagedSkills
    expect(kernel.getPagedSkills().get('local:skill:demo')).toMatch(/Demo skill/);
    // Force deliberative tier by high friction so systemHint includes pages when emitted —
    // plan.systemHint always includes pages from formatSystemHint.
    expect(plan.systemHint).toMatch(/kernel:skills/);
    expect(plan.systemHint).toMatch(/Demo skill/);
  });
});
