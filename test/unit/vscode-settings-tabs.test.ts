import { describe, expect, it } from 'vitest';
import {
  SECTIONS,
  TAB_FOR_SECTION,
  TABS,
  cardHtml,
  isTabId,
  nextTabFor,
  nextTabForKey,
  tabForSection,
  tabPanelHtml,
  tabsHtml,
  type TabId,
} from '../../vscode/src/webview/settingsLayout.js';

describe('settings tabs', () => {
  it('lists the five tabs in the order the header shows them', () => {
    expect(TABS.map((t) => t.id)).toEqual([
      'providers',
      'agent',
      'tools',
      'appearance',
      'advanced',
    ]);
    expect(TABS.map((t) => t.label)).toEqual([
      'Providers & Models',
      'Agent',
      'Tools',
      'Appearance',
      'Advanced',
    ]);
    for (const tab of TABS) expect(isTabId(tab.id)).toBe(true);
    expect(isTabId('nope')).toBe(false);
    expect(isTabId(undefined)).toBe(false);
  });

  it('puts every existing section in exactly one tab', () => {
    expect(Object.keys(TAB_FOR_SECTION).sort()).toEqual(SECTIONS.map((s) => s.id).sort());
    for (const s of SECTIONS) expect(TABS.some((t) => t.id === tabForSection(s.id))).toBe(true);

    expect(tabForSection('model')).toBe('providers');
    expect(tabForSection('providers')).toBe('providers');
    expect(tabForSection('add')).toBe('providers');
    expect(tabForSection('agent')).toBe('agent');
    expect(tabForSection('models')).toBe('agent');
    expect(tabForSection('approvals')).toBe('agent');
    expect(tabForSection('mcp')).toBe('tools');
    expect(tabForSection('skills')).toBe('tools');
    expect(tabForSection('browser')).toBe('tools');
    expect(tabForSection('shortcuts')).toBe('appearance');
    expect(tabForSection('advanced')).toBe('advanced');
  });

  it('moves between tabs with arrows, Home and End, wrapping at the ends', () => {
    expect(nextTabFor('providers', 'ArrowRight')).toBe('agent');
    expect(nextTabFor('advanced', 'ArrowRight')).toBe('providers');
    expect(nextTabFor('providers', 'ArrowLeft')).toBe('advanced');
    expect(nextTabFor('tools', 'Home')).toBe('providers');
    expect(nextTabFor('tools', 'End')).toBe('advanced');
    expect(nextTabFor('tools', 'Enter')).toBeUndefined();
    expect(nextTabForKey('ArrowLeft', 'agent')).toBe('providers');
    expect(nextTabForKey('Tab', 'agent')).toBeUndefined();
  });

  it('renders a labelled tablist with roving tabindex and ARIA wiring', () => {
    const html = tabsHtml('tools');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Settings tabs"');
    for (const tab of TABS) {
      expect(html).toContain(`id="set-tab-${tab.id}"`);
      expect(html).toContain(`aria-controls="set-panel-${tab.id}"`);
      expect(html).toContain('role="tab"');
    }
    expect(html).toMatch(
      /id="set-tab-tools"[^>]*aria-selected="true"[^>]*aria-controls="set-panel-tools"[^>]*tabindex="0"/,
    );
    expect(html).toMatch(
      /id="set-tab-agent"[^>]*aria-selected="false"[^>]*aria-controls="set-panel-agent"[^>]*tabindex="-1"/,
    );
  });

  it('hides inactive panels and labels each by its tab', () => {
    const active = tabPanelHtml('agent', '<p>x</p>', true);
    expect(active).toContain('role="tabpanel"');
    expect(active).toContain('id="set-panel-agent"');
    expect(active).toContain('aria-labelledby="set-tab-agent"');
    expect(active).toContain('tabindex="0"');
    expect(active).not.toContain(' hidden');

    const inactive = tabPanelHtml('agent', '<p>x</p>', false);
    expect(inactive).toContain(' hidden');
    expect(inactive).toContain('aria-labelledby="set-tab-agent"');
  });

  it('escapes extra card titles and help text', () => {
    const html = cardHtml('<b>', 'a & b', '<p>x</p>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('accepts every tab id as the next tab target', () => {
    const seen = new Set<TabId>();
    for (const tab of TABS) {
      const next = nextTabFor(tab.id, 'ArrowRight');
      if (next) seen.add(next);
    }
    expect([...seen].sort()).toEqual(TABS.map((t) => t.id).sort());
  });
});
