import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { removeTable, setTable } from '../../../src/integrations/toml-edit.js';

describe('toml-edit dotted-key tables', () => {
  const RAW = '[mcp.servers]\ngithub.command = "npx"\n';

  it('setTable replaces a dotted-key table with a real, parseable one', () => {
    const out = setTable(RAW, ['mcp', 'servers', 'github'], { command: 'npx' });
    expect(parse(out)).toEqual({ mcp: { servers: { github: { command: 'npx' } } } });
  });

  it('removeTable strips the dotted keys of the target table', () => {
    const { text, removed } = removeTable(RAW, ['mcp', 'servers', 'github']);
    expect(removed).toBe(true);
    expect(text).not.toContain('github');
    expect(parse(text)).toEqual({ mcp: { servers: {} } });
  });

  it('removeTable strips nested dotted keys but keeps sibling dotted keys', () => {
    const raw =
      '[mcp.servers]\ngithub.command = "npx"\ngithub.sub.command = "x"\nother.url = "http://x"\n';
    const { text, removed } = removeTable(raw, ['mcp', 'servers', 'github']);
    expect(removed).toBe(true);
    expect(text).not.toContain('github');
    expect(text).toContain('other.url');
    expect(parse(text)).toEqual({
      mcp: { servers: { other: { url: 'http://x' } } },
    });
  });

  it('a dotted-key table that matches a header is still removed whole', () => {
    const raw = '[mcp.servers.github]\ncommand = "npx"\n';
    const { text, removed } = removeTable(raw, ['mcp', 'servers', 'github']);
    expect(removed).toBe(true);
    expect(text).not.toContain('github');
  });
});
