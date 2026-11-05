import { describe, expect, it } from 'vitest';
import {
  normalizeMcpServerName,
  registryMirrorsLocal,
} from '../../../src/runtime/kernel/kernel.js';

describe('bug #3: local↔registry mirror match', () => {
  it('normalizes namespaced registry names to the short local key', () => {
    expect(normalizeMcpServerName('io.github.modelcontextprotocol/server-filesystem')).toBe(
      'filesystem',
    );
    expect(normalizeMcpServerName('@modelcontextprotocol/server-github')).toBe('github');
    expect(normalizeMcpServerName('acme/postgres-mcp')).toBe('postgres');
    expect(normalizeMcpServerName('filesystem')).toBe('filesystem');
  });

  it('matches a short local config key against a namespaced registry server', () => {
    expect(
      registryMirrorsLocal('io.github.modelcontextprotocol/server-filesystem', undefined, [
        'filesystem',
      ]),
    ).toBe(true);
    expect(
      registryMirrorsLocal('com.example/thing', '@modelcontextprotocol/server-github', ['github']),
    ).toBe(true);
    expect(registryMirrorsLocal('acme/slack-mcp', undefined, ['filesystem'])).toBe(false);
    expect(registryMirrorsLocal('acme/slack-mcp', undefined, [])).toBe(false);
  });
});
