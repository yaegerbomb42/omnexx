import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { mascotFrame, NEX_WIDTH, type Mood } from '../../../src/tui/mascot.js';

const MOODS: Mood[] = [
  'hello',
  'idle',
  'sleepy',
  'listening',
  'thinking',
  'working',
  'happy',
  'sad',
  'startled',
];

describe('Nex', () => {
  it('every frame is 5 rows of exactly NEX_WIDTH columns, so nothing around it shifts', () => {
    for (const mood of MOODS)
      for (let tick = 0; tick < 40; tick++) {
        const f = mascotFrame(mood, tick);
        expect(f.rows).toHaveLength(5);
        for (const row of f.rows)
          expect(stringWidth(row), `${mood}@${tick}: "${row}"`).toBe(NEX_WIDTH);
      }
  });

  it('animates, reacts, and says what it is doing', () => {
    const frames = (m: Mood) =>
      new Set(Array.from({ length: 12 }, (_, t) => mascotFrame(m, t).rows.join()));
    for (const m of ['hello', 'working', 'happy', 'thinking', 'sleepy'] as const)
      expect(frames(m).size, m).toBeGreaterThan(1);
    expect(mascotFrame('idle', 16).rows[1]).toContain('_______');
    expect(mascotFrame('happy', 0).rows.join()).toContain('(^)');
    expect(mascotFrame('sad', 0).rows.join()).toContain('(.)');
    // The eye follows the cursor: down-left, then down-right as the text grows.
    expect(mascotFrame('listening', 0, '', { x: -1, y: 1 }).rows[3]).toMatch(/^ {2}\\ \(@\)/);
    expect(mascotFrame('listening', 0, '', { x: 1, y: 1 }).rows[3]).toMatch(/\(@\) \/ {2}$/);
    expect(mascotFrame('working', 0, 'running test suite!').caption).toBe('running test suite!');
    expect(mascotFrame('sleepy', 0).caption).toMatch(/type to wake/);
  });
});
