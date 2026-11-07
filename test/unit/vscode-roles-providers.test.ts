/**
 * Provider multi-select in "Your models": the selector, the palette filter, the greyed-out
 * ranked models, and the select → setRoles payload → reopen round-trip. roles.ts touches
 * the DOM only through `document` in redraw(), so a null-returning stub is enough here.
 */
import { describe, expect, it } from 'vitest';

(globalThis as unknown as { document: unknown }).document = {
  getElementById: () => null,
  activeElement: null,
};

const roles = await import('../../vscode/src/webview/roles.js');

const ITEMS = [
  { ref: 'anthropic:claude', provider: 'anthropic', model: 'claude' },
  { ref: 'groq:llama', provider: 'groq', model: 'llama' },
  { ref: 'openrouter:qwen', provider: 'openrouter', model: 'qwen' },
];

const PROVIDERS = [
  { name: 'anthropic', label: 'Anthropic', local: false, hasKey: true },
  { name: 'groq', label: 'Groq', local: false, hasKey: true },
  { name: 'openrouter', label: 'OpenRouter', local: false, hasKey: false },
];

/** A click target matching exactly one selector, like the real closest() walk. */
function fakeEl(matched: string, dataset: Record<string, string>): Element {
  return {
    closest: (sel: string) => (sel === matched ? { dataset } : null),
  } as unknown as Element;
}

describe('provider selection', () => {
  it('toggles one provider; all-usable or none-left saves back as empty ("all")', () => {
    const usable = ['anthropic', 'groq', 'openrouter'];
    expect(roles.toggleProvider([], 'groq', usable)).toEqual(['anthropic', 'openrouter']);
    expect(roles.toggleProvider(['anthropic'], 'groq', usable)).toEqual(['anthropic', 'groq']);
    expect(roles.toggleProvider(['anthropic', 'groq'], 'openrouter', usable)).toEqual([]);
    expect(roles.toggleProvider(['groq'], 'groq', usable)).toEqual([]);
    expect(roles.toggleProvider(['anthropic', 'stale'], 'groq', usable)).toEqual([
      'anthropic',
      'groq',
    ]);
  });

  it('select → payload → reopen: palette filters, ranked models stay but grey out', () => {
    const posted: Record<string, unknown>[] = [];
    const post = (msg: Record<string, unknown>): void => {
      posted.push(msg);
    };
    roles.request(post);
    roles.onMessage({ type: 'models', items: ITEMS });
    roles.onMessage({
      type: 'roles',
      roles: { models: {}, strategies: {}, spreadHelpers: true },
      pool: {
        ranked: ['anthropic:claude', 'groq:llama', 'openrouter:qwen'],
        mode: 'fallback',
        providers: ['anthropic'],
      },
      exhausted: {},
    });
    roles.setProviders(PROVIDERS);

    let html = roles.html();
    // Selector: anthropic on, groq off, openrouter disabled (no key).
    expect(html).toMatch(/data-provider-toggle="anthropic"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-provider-toggle="groq"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-provider-toggle="openrouter"[^>]*disabled/);
    expect(html).toContain('no key');
    // Palette: only anthropic models are offered.
    expect(html).toContain('data-pal-add="anthropic:claude"');
    expect(html).not.toContain('data-pal-add="groq:llama"');
    // Ranked list: nothing deleted, but the unselected providers' models are greyed.
    expect(html).toMatch(/class="rchip inactive"[^>]*data-ref="groq:llama"/);
    expect(html).toMatch(/class="rchip inactive"[^>]*data-ref="openrouter:qwen"/);
    expect(html).not.toMatch(/class="rchip inactive"[^>]*data-ref="anthropic:claude"/);
    expect(html).toContain('Skipped until re-selected: groq, openrouter.');

    // Select groq: every usable provider is now on, so the payload saves "all" (empty).
    posted.length = 0;
    expect(roles.click(fakeEl('[data-provider-toggle]', { providerToggle: 'groq' }), post)).toBe(
      true,
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'setRoles' });
    expect((posted[0]?.pool as { providers: string[] }).providers).toEqual([]);
    html = roles.html();
    expect(html).toContain('data-pal-add="groq:llama"');
    expect(html).not.toContain('class="rchip inactive"');

    // Deselect groq again: back to just anthropic, and the ranked list greys groq out.
    posted.length = 0;
    roles.click(fakeEl('[data-provider-toggle]', { providerToggle: 'groq' }), post);
    expect((posted[0]?.pool as { providers: string[] }).providers).toEqual(['anthropic']);
    html = roles.html();
    expect(html).not.toContain('data-pal-add="groq:llama"');
    expect(html).toMatch(/class="rchip inactive"[^>]*data-ref="groq:llama"/);
    expect(html).toContain('groq:llama');

    // Reopen: the host echoes the saved pool back, and the UI shows it as it was.
    roles.onMessage({
      type: 'roles',
      roles: { models: {}, strategies: {}, spreadHelpers: true },
      pool: {
        ranked: ['anthropic:claude', 'groq:llama', 'openrouter:qwen'],
        mode: 'fallback',
        providers: ['anthropic'],
      },
      exhausted: {},
    });
    html = roles.html();
    expect(html).toMatch(/data-provider-toggle="anthropic"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-provider-toggle="groq"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/class="rchip inactive"[^>]*data-ref="groq:llama"/);
    expect(html).toContain('groq:llama');

    // "All" resets the selection to empty.
    posted.length = 0;
    roles.click(fakeEl('[data-provider-all]', {}), post);
    expect((posted[0]?.pool as { providers: string[] }).providers).toEqual([]);
  });
});
