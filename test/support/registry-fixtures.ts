import type { RegistryServer } from '../../src/integrations/registry.js';

/** Shapes copied from registry.modelcontextprotocol.io (2026-10-09). */
export const PLAYWRIGHT: RegistryServer = {
  name: 'io.github.microsoft/playwright-mcp',
  version: '0.0.82',
  packages: [
    {
      registryType: 'npm',
      identifier: '@playwright/mcp',
      version: '0.0.82',
      transport: { type: 'stdio' },
    },
  ],
  remotes: null,
};
export const GITHUB: RegistryServer = {
  name: 'io.github.github/github-mcp-server',
  title: 'GitHub',
  version: '2.0.2',
  packages: [
    {
      registryType: 'oci',
      identifier: 'ghcr.io/github/github-mcp-server:2.0.2',
      transport: { type: 'stdio' },
    },
  ],
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: [{ name: 'Authorization', description: 'PAT', isSecret: true }],
    },
  ],
};
