import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { mascotFrame, type Mood } from '../../../src/tui/mascot.js';

const MOODS: Mood[] = ['idle', 'thinking', 'working', 'happy', 'sad'];

describe('mascot', () => {
  it('every frame is exactly 3 rows of 5 columns, so the input box never jumps', () => {
    for (const mood of MOODS)
      for (let tick = 0; tick < 32; tick++)
        for (const row of mascotFrame(mood, tick).rows) expect(stringWidth(row)).toBe(5);
  });

  it('moves when working, blinks when idle, and reacts to commits and rejections', () => {
    const working = new Set(
      Array.from({ length: 12 }, (_, t) => mascotFrame('working', t).rows.join()),
    );
    expect(working.size).toBeGreaterThan(2);
    expect(mascotFrame('idle', 0).rows[1]).toBe('▐o.o▌');
    expect(mascotFrame('idle', 15).rows[1]).toBe('▐-.-▌');
    expect(mascotFrame('happy', 0).rows[1]).toBe('▐^‿^▌');
    expect(mascotFrame('sad', 0).caption).toMatch(/rejected/);
    expect(mascotFrame('thinking', 2).caption).toBe('thinking...');
    expect(mascotFrame('idle', 3).caption).toBe('');
  });
});
