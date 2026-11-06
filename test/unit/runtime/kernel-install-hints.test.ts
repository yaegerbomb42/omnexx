import { describe, expect, it } from 'vitest';
import {
  installSuggestion,
  mcpAddCommand,
  skillInstallHint,
} from '../../../src/runtime/kernel/registry.js';

describe('bug #17: install suggestions use real CLI entry points', () => {
  it('suggests `omnexx mcp add <short> --pick <server>`', () => {
    expect(mcpAddCommand('io.github.acme/server-foo')).toBe(
      'omnexx mcp add server-foo --pick io.github.acme/server-foo',
    );
    const text = installSuggestion({
      id: 'registry:mcp:io.github.acme/server-foo',
      kind: 'mcp',
      name: 'foo',
      description: '',
      server: 'io.github.acme/server-foo',
      source: 'mcp-registry',
      installable: true,
    });
    expect(text).toContain('omnexx mcp add server-foo --pick io.github.acme/server-foo');
  });

  it('skill hints never reference the unverified `npx skillmds` CLI', () => {
    const hint = skillInstallHint('pdf');
    expect(hint).toContain('omnexx skills search pdf');
    expect(hint).toContain('omnexx skills add');
    expect(hint).not.toMatch(/skillmds/);
  });
});
