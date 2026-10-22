import { describe, expect, it } from 'vitest';
import { parseReproTest, REPRO_DIR } from '../../../src/swe-bench/reproduce.js';

describe('reproduce', () => {
  describe('parseReproTest', () => {
    it('parses valid reproduction test', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(result).toEqual(input);
    });

    it('rejects missing object', () => {
      const result = parseReproTest(null);
      expect(typeof result).toBe('string');
    });

    it('rejects command without repro dir', () => {
      const input = {
        command: 'node --test test.js',
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
      expect(result).toContain(REPRO_DIR);
    });

    it('rejects files outside repro dir', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [{ path: 'src/test.js', content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
    });

    it('rejects multi-line command', () => {
      const input = {
        command: `cd ${REPRO_DIR}\nnode test.js`,
        files: [{ path: `${REPRO_DIR}/test.js`, content: 'console.log("test");' }],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
      expect(result).toContain('one line');
    });

    it('rejects empty files array', () => {
      const input = {
        command: `node --test ${REPRO_DIR}/test.js`,
        files: [],
      };

      const result = parseReproTest(input);
      expect(typeof result).toBe('string');
    });

    it('trims excess files to max limit', () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `${REPRO_DIR}/test${i}.js`,
        content: `console.log(${i});`,
      }));
      const input = {
        command: `node --test ${REPRO_DIR}/test0.js`,
        files,
      };

      const result = parseReproTest(input);
      if (typeof result !== 'string') {
        expect(result.files.length).toBeLessThanOrEqual(3);
      }
    });
  });
});
