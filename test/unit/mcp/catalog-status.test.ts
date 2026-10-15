import { describe, expect, it } from 'vitest';
import { mcpServerSchema } from '../../../src/config/sections/mcp.js';
import { findGalleryEntry, GALLERY, planGalleryInstall } from '../../../src/mcp/catalog.js';
import { describeStartFailure, tail, toolTokens } from '../../../src/mcp/status.js';

describe('MCP gallery', () => {
  it('has the popular servers with unique ids', () => {
    const ids = GALLERY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'filesystem',
      'github',
      'playwright',
      'postgres',
      'sqlite',
      'fetch',
      'memory',
      'context7',
      'sentry',
      'linear',
      'notion',
      'slack',
    ])
      expect(findGalleryEntry(id), id).toBeDefined();
  });

  it('every entry runs something: a command or a URL', () => {
    for (const g of GALLERY) expect(Boolean(g.command ?? g.url), g.id).toBe(true);
  });

  it('leaves an optional header out when nothing was given', () => {
    const c7 = findGalleryEntry('context7');
    if (!c7) throw new Error('context7 missing');
    expect(planGalleryInstall(c7, {})).toEqual({
      table: { url: 'https://mcp.context7.com/mcp' },
      secrets: {},
    });
  });

  it('oauth entries are marked for sign-in', () => {
    const notion = findGalleryEntry('notion');
    if (!notion) throw new Error('notion missing');
    expect(planGalleryInstall(notion, {}).table.oauth).toBe(true);
  });
});

describe('MCP status', () => {
  const stdio = mcpServerSchema.parse({ command: 'npx', args: ['-y', 'x'] });
  const remote = mcpServerSchema.parse({ url: 'https://example.invalid/mcp' });

  it('counts a tool by its name, description and schema', () => {
    const small = toolTokens({ name: 'a', inputSchema: { type: 'object' } });
    const big = toolTokens({
      name: 'a',
      description: 'x'.repeat(300),
      inputSchema: { type: 'object' },
    });
    expect(big - small).toBeGreaterThanOrEqual(100);
  });

  it('explains common start failures in plain words', () => {
    const enoent = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    expect(describeStartFailure('fs', stdio, enoent, '')).toMatch(
      /"npx" was not found on PATH \(npx comes with Node.js/,
    );
    expect(describeStartFailure('r', remote, new Error('HTTP 401 Unauthorized'), '')).toContain(
      'omnexx mcp login r',
    );
    expect(describeStartFailure('r', remote, new Error('fetch failed'), '')).toContain(
      'could not reach https://example.invalid/mcp',
    );
    expect(
      describeStartFailure(
        'fs',
        stdio,
        new Error('Connection closed'),
        'line1\nError: bad token\n',
      ),
    ).toBe(
      'MCP server "fs" failed to start: it exited during startup\n--- its output ---\nline1\nError: bad token',
    );
  });

  it('keeps only the last lines of a log', () => {
    expect(tail('a\nb\n\nc\nd', 2)).toBe('c\nd');
  });
});
