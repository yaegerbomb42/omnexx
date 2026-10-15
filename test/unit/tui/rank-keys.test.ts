import { describe, expect, it } from 'vitest';
import {
  moveItem,
  rankNote,
  rankReduce,
  type RankKey,
  type RankState,
} from '../../../src/tui/model-picker.js';

const start = (over: Partial<RankState> = {}): RankState => ({
  ranked: ['p:a', 'p:b', 'p:c'],
  mode: 'fallback',
  exhausted: new Set(),
  cursor: 0,
  grabbed: false,
  ...over,
});

const press = (s: RankState, ...keys: RankKey[]): RankState => keys.reduce(rankReduce, s);

describe('/models keys', () => {
  it('↑↓ move the cursor within the list without reordering', () => {
    const s = press(start(), 'down', 'down', 'down');
    expect(s.cursor).toBe(2);
    expect(s.ranked).toEqual(['p:a', 'p:b', 'p:c']);
    expect(press(s, 'up').cursor).toBe(1);
    expect(press(start(), 'up').cursor).toBe(0);
  });

  it('shift+↑↓ move the selected model up and down the ranking', () => {
    const s = press(start(), 'move-down', 'move-down');
    expect(s.ranked).toEqual(['p:b', 'p:c', 'p:a']);
    expect(s.cursor).toBe(2);
    expect(press(s, 'move-up').ranked).toEqual(['p:b', 'p:a', 'p:c']);
  });

  it('space picks a row up so ↑↓ carry it, and drops it again', () => {
    const s = press(start({ cursor: 2 }), 'grab', 'up', 'up');
    expect(s.ranked).toEqual(['p:c', 'p:a', 'p:b']);
    const dropped = press(s, 'grab', 'down');
    expect(dropped.grabbed).toBe(false);
    expect(dropped.ranked).toEqual(['p:c', 'p:a', 'p:b']);
  });

  it('x removes the selected model and keeps the cursor in range', () => {
    const s = press(start({ cursor: 2 }), 'remove');
    expect(s.ranked).toEqual(['p:a', 'p:b']);
    expect(s.cursor).toBe(1);
    expect(press(s, 'remove', 'remove').ranked).toEqual([]);
  });

  it('m cycles random, rank priority, fallback on quota', () => {
    const modes = [1, 2, 3].map((n) => press(start(), ...Array<RankKey>(n).fill('mode')).mode);
    expect(modes).toEqual(['random', 'priority', 'fallback']);
  });

  it('never changes the state it was given', () => {
    const s = start();
    press(s, 'move-down', 'remove', 'mode');
    expect(s).toEqual(start());
  });

  it('notes what each rank means in the current mode', () => {
    expect(rankNote('fallback', 0, false)).toBe('used until it runs out');
    expect(rankNote('priority', 0, false)).toBe('tried first every call');
    expect(rankNote('priority', 1, false)).toBe('first fallback');
    expect(rankNote('random', 0, false)).toBe('picked at random');
    expect(rankNote('random', 0, true)).toMatch(/out of quota/);
    expect(moveItem(['x'], 0, 3)).toEqual(['x']);
  });
});
