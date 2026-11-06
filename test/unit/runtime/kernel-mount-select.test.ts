import { describe, expect, it } from 'vitest';
import { CapabilityCatalog } from '../../../src/runtime/kernel/catalog.js';

const e = (id: string, name: string, description: string) => ({
  id,
  kind: 'mcp' as const,
  name,
  description,
  server: `x/${name}`,
});

describe('mount-set selection', () => {
  const cat = () => {
    const c = new CapabilityCatalog();
    c.load([
      e('registry:mcp:a', 'slack', 'Slack messages and channels'),
      e('registry:mcp:b', 'slack-bot', 'Slack bot messages and channels'),
      e('registry:mcp:c', 'slack-notify', 'Slack channel notifications'),
      e('registry:mcp:d', 'linear', 'Linear issues and tickets'),
      e('registry:mcp:z', 'weather', 'Weather forecasts'),
      // realistic IDF: product names are rare in a big catalog
      ...Array.from({ length: 60 }, (_, i) =>
        e(`registry:mcp:f${i}`, `filler-${i}`, `generic utility number ${i}`),
      ),
    ]);
    return c;
  };

  it('mounts one server per named product and skips weak matches', () => {
    const ids = cat()
      .select({ query: 'post to slack and open a linear ticket', maxMounted: 6 })
      .mounted.map((m) => m.id);
    expect(
      ids.filter((id) => ['registry:mcp:a', 'registry:mcp:b', 'registry:mcp:c'].includes(id)),
    ).toHaveLength(1);
    expect(ids).toContain('registry:mcp:d');
    expect(ids).not.toContain('registry:mcp:z');
  });

  it('keeps already-mounted capabilities on a re-select (hysteresis)', () => {
    const c = cat();
    const first = c.select({ query: 'post to slack', maxMounted: 3 }).mounted.map((m) => m.id);
    const second = c.select({ query: 'post to slack\ncontinue', maxMounted: 3 });
    expect(second.added).toEqual([]);
    expect(second.mounted.map((m) => m.id)).toEqual(first);
  });
});
