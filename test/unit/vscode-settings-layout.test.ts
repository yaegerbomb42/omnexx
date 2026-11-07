import { describe, expect, it } from 'vitest';
import { SLIDERS } from '../../vscode/src/webview/agentCardModel.js';
import { cardHtml, registryCards, toCards } from '../../vscode/src/webview/mcpCards.js';
import { mcpBlurb, mcpIcon } from '../../vscode/src/webview/mcpIcons.js';
import {
  FOLDED_BY_DEFAULT,
  SECTIONS,
  emptyHtml,
  isSectionId,
  sectionHtml,
  toggled,
} from '../../vscode/src/webview/settingsLayout.js';

describe('settings layout', () => {
  it('shows only the essentials open: agent, model, models, providers, approvals', () => {
    for (const id of ['agent', 'model', 'models', 'providers', 'approvals']) {
      expect(FOLDED_BY_DEFAULT).not.toContain(id);
    }
    for (const id of ['add', 'browser', 'advanced', 'skills', 'mcp', 'shortcuts']) {
      expect(FOLDED_BY_DEFAULT).toContain(id);
    }
  });
  it('gives every section a subtitle', () => {
    for (const s of SECTIONS) {
      expect(s.subtitle.length).toBeGreaterThan(10);
    }
  });

  it('only renders tab nav chips when a tab has 3 or more sections', () => {
    // providers tab has: model, providers, add (3 sections) -> rendered
    const providersNav = navHtml({}, undefined, 'providers');
    expect(providersNav).toContain('data-sec="providers"');
    expect(providersNav).toContain('data-sec="add"');

    // agent tab has: agent, models, approvals (3 sections) -> rendered
    const agentNav = navHtml({}, undefined, 'agent');
    expect(agentNav).toContain('data-sec="agent"');

    // tools tab has: skills, mcp, browser (3 sections) -> rendered
    const toolsNav = navHtml({}, undefined, 'tools');
    expect(toolsNav).toContain('data-sec="skills"');

    // appearance tab has only: shortcuts (1 section) -> omitted
    const appearanceNav = navHtml({}, undefined, 'appearance');
    expect(appearanceNav).toBe('');

    // advanced tab has only: advanced (1 section) -> omitted
    const advancedNav = navHtml({}, undefined, 'advanced');
    expect(advancedNav).toBe('');
  });

  it('draws a section folded or open with its header toggle', () => {
    const open = sectionHtml('models', '<p>x</p>', false);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('Which models answer, and in what order');
    const folded = sectionHtml('models', '<p>x</p>', true);
    expect(folded).toContain('class="set-section folded"');
    expect(folded).toContain('id="sec-body-models" hidden');
  });

  it('folds and unfolds without mutating, and validates ids', () => {
    const start = ['add'] as const;
    expect(toggled(start, 'mcp', true)).toEqual(['add', 'mcp']);
    expect(toggled(start, 'add', false)).toEqual([]);
    expect(start).toEqual(['add']);
    expect(isSectionId('skills')).toBe(true);
    expect(isSectionId('nope')).toBe(false);
  });

  it('escapes empty-state text', () => {
    expect(emptyHtml('<b>', 'a & b')).toContain('&lt;b&gt;');
  });

  it('labels max tokens as reply length, with a hint that it is output', () => {
    const tokens = SLIDERS.find((s) => s.id === 'maxTokens');
    expect(tokens?.name).toBe('Max reply length');
    expect(tokens?.hint).toMatch(/per reply \(output\), not what it remembers/);
  });
});

describe('MCP gallery cards', () => {
  it('gives every server the shared badge: two letters on a stable hue', () => {
    expect(mcpIcon('postgres')).toContain('class="badge"');
    expect(mcpIcon('postgres')).toContain('>PO<');
    expect(mcpIcon('notion')).toContain('>NO<');
    expect(mcpIcon('my-tool')).toMatch(/class="badge" style="--h:\d+">MY</);
  });

  it('takes the first sentence of the description as its one-liner', () => {
    expect(mcpBlurb('notion', 'docs & files')).toBe('docs & files');
    expect(mcpBlurb('x', 'Does a thing. More detail.')).toBe('Does a thing.');
  });

  it('shows the description on gallery and registry cards', () => {
    const [gallery] = toCards({
      entries: [{ id: 'fetch', name: 'Fetch', description: 'Fetch pages', command: 'npx' }],
    });
    if (!gallery) throw new Error('no card');
    expect(cardHtml(gallery)).toContain('Fetch pages');
    const [hit] = registryCards({
      hits: [
        { id: 'w', title: 'Weather', description: 'Forecasts', publisher: 'acme', runs: 'npx' },
      ],
    });
    expect(hit?.sub).toBe('acme · npx');
    expect(hit?.note).toMatch(/Not a known publisher/);
    if (!hit) throw new Error('no hit');
    expect(cardHtml(hit, true)).toContain('Forecasts');
    expect(cardHtml(hit, true)).toContain('aria-pressed="true"');
  });
});
