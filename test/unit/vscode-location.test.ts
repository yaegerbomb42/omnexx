import { describe, expect, it } from 'vitest';
import { parseLocation } from '../../vscode/src/location.js';
import { looksLikePath } from '../../vscode/src/webview/render.js';

describe('parseLocation', () => {
  it('keeps a bare path whole', () => {
    expect(parseLocation('src/a.ts')).toEqual({ file: 'src/a.ts' });
    expect(parseLocation('./docs/README.md')).toEqual({ file: './docs/README.md' });
  });

  it('splits a line suffix', () => {
    expect(parseLocation('src/a.ts:12')).toEqual({ file: 'src/a.ts', line: 12 });
  });

  it('splits a line and column suffix', () => {
    expect(parseLocation('src/a.ts:12:5')).toEqual({ file: 'src/a.ts', line: 12, column: 5 });
  });

  it('handles absolute paths and nested directories', () => {
    expect(parseLocation('/tmp/x/y.ts:3:1')).toEqual({
      file: '/tmp/x/y.ts',
      line: 3,
      column: 1,
    });
  });

  it('treats a lone number suffix as the path when nothing precedes it', () => {
    expect(parseLocation(':12')).toEqual({ file: ':12' });
  });

  it('agrees with the renderer about what is linkable', () => {
    // The panel only links references that lookLikePath accepts; every one of those that carries
    // a position must survive parseLocation with its file intact.
    for (const spec of ['src/a.ts:12', 'src/a.ts:12:5', 'lib/b.js:7']) {
      expect(looksLikePath(spec)).toBe(true);
      expect(parseLocation(spec).file).toBe(spec.split(':')[0]);
    }
  });
});
