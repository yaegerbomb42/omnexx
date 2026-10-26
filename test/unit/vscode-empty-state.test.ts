import { describe, expect, it } from 'vitest';
import { EMPTY_STATE_TEXT, emptyStateHtml } from '../../vscode/src/webview/emptyState.js';

describe('empty state', () => {
  it('renders the exact hint text verbatim', () => {
    expect(EMPTY_STATE_TEXT).toBe('no runs yet: /run <goal> starts one');
    expect(emptyStateHtml()).toContain('no runs yet: /run <goal> starts one');
  });

  it('renders a node carrying the empty class', () => {
    expect(emptyStateHtml()).toMatch(/class="empty"/);
  });
});
