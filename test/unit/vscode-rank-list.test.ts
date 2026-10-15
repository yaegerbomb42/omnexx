import { describe, expect, it } from 'vitest';
import {
  filterModels,
  listHtml,
  modeHtml,
  modeOf,
  paletteChipsHtml,
  placeRef,
  removeRef,
  shiftRef,
} from '../../vscode/src/webview/rankList.js';

const list = ['groq:a', 'groq:b', 'openrouter:c'];

describe('ranked model list', () => {
  it('adds a model at the end, or where it was dropped, without duplicates', () => {
    expect(placeRef(list, 'ollama:d')).toEqual([...list, 'ollama:d']);
    expect(placeRef(list, 'ollama:d', 0)).toEqual(['ollama:d', ...list]);
    expect(placeRef(list, 'groq:a')).toEqual(['groq:b', 'openrouter:c', 'groq:a']);
    expect(placeRef(['x:1', 'x:2'], 'x:3', undefined, 2)).toEqual(['x:1', 'x:2']);
  });

  it('reorders by dropping a chip on another: it takes that place', () => {
    expect(placeRef(list, 'groq:a', 2)).toEqual(['groq:b', 'openrouter:c', 'groq:a']);
    expect(placeRef(list, 'openrouter:c', 0)).toEqual(['openrouter:c', 'groq:a', 'groq:b']);
  });

  it('moves up and down by keyboard and removes with ×', () => {
    expect(shiftRef(list, 2, -1)).toEqual(['groq:a', 'openrouter:c', 'groq:b']);
    expect(shiftRef(list, 0, -1)).toEqual(list);
    expect(shiftRef(list, 0, 5)).toEqual(['groq:b', 'openrouter:c', 'groq:a']);
    expect(shiftRef(list, 9, 1)).toEqual(list);
    expect(removeRef(list, 'groq:b')).toEqual(['groq:a', 'openrouter:c']);
    expect(list).toEqual(['groq:a', 'groq:b', 'openrouter:c']);
  });

  it('searches the palette by every typed word', () => {
    const items = list.map((ref) => {
      const [provider = '', model = ''] = ref.split(':');
      return { ref, provider, model };
    });
    expect(filterModels(items, 'groq b').map((m) => m.ref)).toEqual(['groq:b']);
    expect(filterModels(items, '')).toHaveLength(3);
    const html = paletteChipsHtml(items, new Set(['groq:a']));
    expect(html).toContain('data-pal-add="groq:b"');
    expect(html).toMatch(/class="rchip pal added"[^>]*data-ref="groq:a"/);
    expect(paletteChipsHtml([], new Set())).toContain('No models match');
  });

  it('numbers the ranks 1, 2, 3 and marks models out of quota', () => {
    const html = listHtml('pool', list, { 'groq:b': 1 }, 'empty');
    expect([...html.matchAll(/class="rc-n">(\d+)</g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(html).toMatch(/class="rchip out"[^>]*data-ref="groq:b"/);
    expect(listHtml('pool', [], {}, 'Nothing yet')).toContain('Nothing yet');
  });

  it('shows exactly the three modes, the chosen one pressed with its explanation', () => {
    const html = modeHtml('pool', 'priority');
    expect([...html.matchAll(/data-rank-mode="(\w+)"/g)].map((m) => m[1])).toEqual([
      'random',
      'priority',
      'fallback',
    ]);
    expect(html).toMatch(/data-rank-mode="priority"[^>]*aria-pressed="true"/);
    expect(html).toContain('Always tries #1 first');
    expect(modeOf('least-busy')).toBe('fallback');
    expect(modeOf('random')).toBe('random');
  });
});
