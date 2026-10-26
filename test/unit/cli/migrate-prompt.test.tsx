import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MigratePrompt } from '../../../src/cli/migratePrompt.js';
import type { MigratePlan } from '../../../src/cli/migrate.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function plan(): MigratePlan {
  return {
    detections: [
      {
        tool: 'claude-code',
        scope: 'user',
        detected: true,
        paths: ['/home/.claude/settings.json', '/home/.claude.json'],
        settings: {
          model: 'opus',
          envNames: ['CI'],
          deny: [],
          hooks: [{ on: 'pre_tool', run: 'echo guard', match: 'Bash' }],
          skippedHooks: 0,
          notes: [],
        },
        servers: [
          {
            name: 'github',
            source: 'Claude Code',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {},
            headers: {},
          },
        ],
      },
      {
        tool: 'claude-code',
        scope: 'project',
        detected: false,
        paths: [],
        servers: [],
      },
      {
        tool: 'cursor',
        scope: 'user',
        detected: false,
        paths: [],
        servers: [],
      },
      {
        tool: 'cursor',
        scope: 'project',
        detected: true,
        paths: ['/repo/.cursor/rules'],
        servers: [],
      },
    ],
    items: [
      {
        id: 'a',
        tool: 'claude-code',
        scope: 'user',
        kind: 'server',
        file: '/cfg/config.toml',
        label: 'MCP server "github"',
        detail: 'npx -y @modelcontextprotocol/server-github',
        server: {
          name: 'github',
          source: 'Claude Code',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {},
          headers: {},
        },
      },
      {
        id: 'b',
        tool: 'claude-code',
        scope: 'user',
        kind: 'model',
        file: '/cfg/config.toml',
        label: 'model opus',
        detail: 'worker = "anthropic:opus"',
        modelRef: 'anthropic:opus',
      },
      {
        id: 'c',
        tool: 'cursor',
        scope: 'project',
        kind: 'policy-env',
        file: '/repo/omnexx.toml',
        label: 'env passthrough',
        detail: 'CI',
        envNames: ['CI'],
      },
    ],
    files: ['/cfg/config.toml', '/repo/omnexx.toml'],
  };
}

describe('MigratePrompt', () => {
  it('lists detected and not-detected tools with the same tokens as the report', async () => {
    const { lastFrame, unmount } = render(
      <MigratePrompt
        plan={plan()}
        onMigrate={() => Promise.resolve([])}
        onExit={() => undefined}
      />,
    );
    await tick();
    const frame = lastFrame();
    expect(frame).toContain('migrate');
    expect(frame).toContain('claude-code');
    expect(frame).toContain('cursor');
    expect(frame).toContain('not detected');
    expect(frame).toContain('1 server');
    expect(frame).toContain('model opus');
    expect(frame).toContain('/cfg/config.toml');
    expect(frame).toContain('enter migrate');
    unmount();
  });

  it('space toggles a row; enter applies only the selected items, then closes', async () => {
    const onMigrate = vi.fn((ids: readonly string[]) =>
      Promise.resolve(ids.map((id) => `✓ ${id}`)),
    );
    const onExit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <MigratePrompt plan={plan()} onMigrate={onMigrate} onExit={onExit} />,
    );
    await tick();

    // Move to the cursor row (second selectable), toggle it off, and migrate.
    stdin.write('\u001B[B');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    expect(onMigrate).toHaveBeenCalledTimes(1);
    expect(onMigrate.mock.calls[0]?.[0]).toEqual(['a', 'b']);
    expect(lastFrame()).toContain('✓ a');
    expect(lastFrame()).toContain('applied — enter / q to close');

    stdin.write('\r');
    await tick();
    expect(onExit).toHaveBeenCalledWith({ cancelled: false, lines: ['✓ a', '✓ b'] });
    unmount();
  });

  it('q quits without applying', async () => {
    const onMigrate = vi.fn(() => Promise.resolve([]));
    const onExit = vi.fn();
    const { stdin, unmount } = render(
      <MigratePrompt plan={plan()} onMigrate={onMigrate} onExit={onExit} />,
    );
    await tick();
    stdin.write('q');
    await tick();
    expect(onMigrate).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith({ cancelled: true, lines: [] });
    unmount();
  });

  it('esc cancels without applying', async () => {
    const onMigrate = vi.fn(() => Promise.resolve([]));
    const onExit = vi.fn();
    const { stdin, unmount } = render(
      <MigratePrompt plan={plan()} onMigrate={onMigrate} onExit={onExit} />,
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onMigrate).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith({ cancelled: true, lines: [] });
    unmount();
  });

  it('enter with nothing selected hints instead of applying', async () => {
    const onMigrate = vi.fn(() => Promise.resolve([]));
    const onExit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <MigratePrompt plan={plan()} onMigrate={onMigrate} onExit={onExit} />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('\u001B[B');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onMigrate).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('nothing selected');
    expect(onExit).not.toHaveBeenCalled();
    unmount();
  });
});
