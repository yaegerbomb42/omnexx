import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE_TEXT,
  QUICK_STARTS,
  chatEmptyStateHtml,
  emptyStateHtml,
  quickStartCards,
} from '../../vscode/src/webview/emptyState.js';

describe('empty state', () => {
  it('renders the exact hint text verbatim', () => {
    expect(EMPTY_STATE_TEXT).toBe('no runs yet: /run <goal> starts one');
    expect(emptyStateHtml()).toContain('no runs yet: /run <goal> starts one');
  });

  it('renders a node carrying the empty class', () => {
    expect(emptyStateHtml()).toMatch(/class="empty"/);
  });

  it('renders clean stroke SVG icons for each quick start card with data-suggest intact', () => {
    const cards = quickStartCards();
    for (const q of QUICK_STARTS) {
      expect(cards).toContain(`data-suggest="${q.prompt}"`);
      expect(cards).toContain(q.title);
      expect(cards).toContain(q.hint);
      expect(q.icon).toContain('<svg');
      expect(q.icon).toContain('viewBox="0 0 24 24"');
    }
  });

  it('renders full chat empty state with onboarding header and quick start cards', () => {
    const chatEmpty = chatEmptyStateHtml();
    expect(chatEmpty).toContain('class="empty empty-chat"');
    expect(chatEmpty).toContain('Welcome to omnexx');
    expect(chatEmpty).toContain('suggestion-card');
  });
});
