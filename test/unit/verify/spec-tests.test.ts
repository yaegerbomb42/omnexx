import { describe, expect, it } from 'vitest';
import { configSchema } from '../../../src/config/schema.js';
import {
  countRequirements,
  parseSuite,
  publicInterface,
  specTestsWanted,
  suiteBroken,
  suiteImplausible,
  testCounts,
} from '../../../src/verify/spec-tests.js';

const config = (review: object = {}, plan: object = {}) =>
  configSchema.parse({ review: { spec_tests: 'auto', ...review }, plan });
const LIST = ['1. add', '2. remove', '- list', '* count', '3) reserve'].join('\n');

describe('specTestsWanted', () => {
  it('auto: wants spec tests for a goal listing several requirements', () => {
    expect(countRequirements(LIST)).toBe(5);
    expect(specTestsWanted(config(), `Build it:\n${LIST}`, false)).toBe(true);
  });

  it('auto: skips a short goal with few requirements', () => {
    expect(specTestsWanted(config(), 'Fix the typo in README.', false)).toBe(false);
  });

  it('auto: wants them for a goal above the fast-path size', () => {
    const cfg = config({}, { fast_max_goal_chars: 10 });
    expect(specTestsWanted(cfg, 'a long goal here', false)).toBe(true);
  });

  it('on and off override the size check; writing runs never get them', () => {
    expect(specTestsWanted(config({ spec_tests: 'on' }), 'tiny', false)).toBe(true);
    expect(specTestsWanted(config({ spec_tests: 'off' }), LIST, false)).toBe(false);
    expect(specTestsWanted(config({ spec_tests: 'on' }), LIST, true)).toBe(false);
  });
});

describe('publicInterface', () => {
  it('keeps exported signatures and method headers but never bodies', () => {
    const text = [
      'export class InventoryError extends Error {',
      '  constructor(code, message) {',
      '    super(message);',
      '  }',
      '}',
      'export function createInventory() {',
      '  const stock = new Map();',
      '  return {',
      '    fulfil(id) {',
      '      if (available(sku) < qty) throw new Error("x");',
      '    },',
      '  };',
      '}',
    ].join('\n');
    const out = publicInterface([
      { path: 'src/index.js', text },
      { path: 'test/index.test.js', text: 'export function secret() {}' },
    ]);
    expect(out).toContain('## src/index.js');
    expect(out).toContain('export class InventoryError extends Error');
    expect(out).toContain('export function createInventory()');
    expect(out).toContain('fulfil(id)');
    expect(out).not.toContain('available(sku)');
    expect(out).not.toContain('new Map');
    expect(out).not.toContain('secret');
  });

  it('cuts an oversized interface', () => {
    const text = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    expect(publicInterface([{ path: 'a.ts', text }], 100)).toMatch(/interface cut/);
  });
});

describe('parseSuite', () => {
  const file = { path: 'omnexx-spec/a.test.mjs', content: 'import test from "node:test";' };
  const command = 'node --test omnexx-spec/';

  it('accepts files under the spec dir and a command that runs them', () => {
    expect(parseSuite({ command, files: [file] })).toEqual({ command, files: [file] });
  });

  it('refuses paths outside the spec dir, traversal, and commands that ignore it', () => {
    expect(parseSuite({ command, files: [{ ...file, path: 'src/a.js' }] })).toMatch(/paths/);
    expect(parseSuite({ command, files: [{ ...file, path: 'omnexx-spec/../x' }] })).toMatch(
      /paths/,
    );
    expect(parseSuite({ command: 'npm test', files: [file] })).toMatch(/must run the files/);
    expect(parseSuite({ command: `${command}\nrm -rf x`, files: [file] })).toMatch(/one line/);
    expect(parseSuite({})).toBeTypeOf('string');
    expect(parseSuite(undefined)).toBe('no answer object');
  });

  it('keeps the first files of a suite over the cap', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      ...file,
      path: `omnexx-spec/t${i}.mjs`,
    }));
    const suite = parseSuite({ command, files });
    expect(typeof suite === 'string' ? suite : suite.files).toHaveLength(8);
  });
});

describe('defaults', () => {
  it('is off unless asked for, with one fix round of at most 3 cycles', () => {
    const review = configSchema.parse({}).review;
    expect(review).toMatchObject({
      spec_tests: 'off',
      spec_tests_max_rounds: 1,
      spec_tests_max_cycles: 3,
    });
  });
});

describe('testCounts and suiteImplausible', () => {
  it('reads node --test, tap, vitest and pytest summaries', () => {
    expect(testCounts('ℹ tests 14\nℹ pass 2\nℹ fail 12')).toEqual({ pass: 2, fail: 12 });
    expect(testCounts('# pass 3\n# fail 0')).toEqual({ pass: 3, fail: 0 });
    expect(testCounts('Tests  2 failed | 5 passed (7)')).toEqual({ pass: 5, fail: 2 });
    expect(testCounts('==== 1 failed, 9 passed in 0.2s')).toEqual({ pass: 9, fail: 1 });
    expect(testCounts('Segmentation fault')).toBeUndefined();
  });

  it('calls a suite wrong when most of it fails on green code', () => {
    expect(suiteImplausible({ pass: 2, fail: 12 })).toBe(true);
    expect(suiteImplausible({ pass: 38, fail: 2 })).toBe(false);
    expect(suiteImplausible({ pass: 1, fail: 1 })).toBe(false);
    expect(suiteImplausible(undefined)).toBe(false);
  });
});

describe('suiteBroken', () => {
  it('tells a suite that never ran from one that failed', () => {
    expect(suiteBroken('No test files found, exiting with code 1')).toBe(true);
    expect(suiteBroken('not ok 1 - fulfil ships reserved stock')).toBe(false);
  });
});
