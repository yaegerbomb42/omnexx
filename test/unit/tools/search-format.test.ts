import { describe, expect, it } from 'vitest';
import { formatHits } from '../../../src/tools/search-format.js';

/** rg -n --with-filename --no-heading -C 2 output for `n` matches in `file`. */
function rgLines(file: string, n: number, start = 10): string[] {
  return Array.from({ length: n }, (_, i) => {
    const at = start + i * 10;
    return [
      `${file}-${String(at - 1)}-  before ${String(i)}`,
      `${file}:${String(at)}:  match ${String(i)}`,
      `${file}-${String(at + 1)}-  after ${String(i)}`,
      '--',
    ];
  }).flat();
}

describe('formatHits', () => {
  it('shows a few matches grouped by file, path once, with their context', () => {
    const out = formatHits(rgLines('src/a.ts', 2));
    expect(out).toBe(
      [
        'src/a.ts',
        '   9-  before 0',
        '  10:  match 0',
        '  11-  after 0',
        '  19-  before 1',
        '  20:  match 1',
        '  21-  after 1',
      ].join('\n'),
    );
  });

  it('drops context lines once there are more than a dozen matches', () => {
    const out = formatHits([...rgLines('src/a.ts', 8), ...rgLines('src/b.ts', 8)]);
    expect(out).not.toContain('before');
    expect(out.split('\n')).toContain('src/b.ts');
    expect(out.split('\n').filter((l) => /^\s+\d+:/.test(l))).toHaveLength(16);
  });

  it('turns a wide search into an overview of files, counts and the first match', () => {
    const many = Array.from({ length: 30 }, (_, i) => rgLines(`src/f${String(i)}.ts`, 3)).flat();
    const out = formatHits(many);
    expect(out).toMatch(/^90 matches in 30 files/);
    expect(out).toContain('src/f0.ts (3)  10:  match 0');
    expect(out).not.toContain('match 1');
    expect(out).toMatch(/narrow with path or glob/);
    expect(out.length).toBeLessThan(2_000);
  });

  it('lists the files with the most matches first in the overview', () => {
    const out = formatHits([...rgLines('src/few.ts', 2), ...rgLines('src/many.ts', 50)]);
    const lines = out.split('\n');
    expect(lines.findIndex((l) => l.startsWith('src/many.ts'))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('src/few.ts')),
    );
  });

  it('handles file names that contain -digits- like rg context separators', () => {
    const out = formatHits([
      'src/v-2-api.ts-2-ctx',
      'src/v-2-api.ts:3:hit',
      'src/v-2-api.ts-4-ctx',
    ]);
    expect(out).toBe('src/v-2-api.ts\n  2-ctx\n  3:hit\n  4-ctx');
  });

  it('reads rg --null output, where the path ends at a NUL byte', () => {
    const out = formatHits(['./src/a.ts\x002-ctx:9:x', './src/a.ts\x003:hit:7:y']);
    expect(out).toBe('src/a.ts\n  2-ctx:9:x\n  3:hit:7:y');
  });

  it('keeps colons in matched text intact', () => {
    const out = formatHits(['src/a.ts:3:const url = "http://x:8080";']);
    expect(out).toBe('src/a.ts\n  3:const url = "http://x:8080";');
  });
});
