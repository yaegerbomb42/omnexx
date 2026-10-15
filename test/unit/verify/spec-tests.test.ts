import { describe, expect, it } from 'vitest';
import { configSchema } from '../../../src/config/schema.js';
import {
  countRequirements,
  parseSuite,
  publicInterface,
  specTestsWanted,
  suiteBroken,
} from '../../../src/verify/spec-tests.js';

const config = (review: object = {}, plan: object = {}) => configSchema.parse({ review, plan });
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
    expect(parseSuite({ command, files: [{ ...file, path: 'src/a.js' }] })).toBeUndefined();
    expect(parseSuite({ command, files: [{ ...file, path: 'omnexx-spec/../x' }] })).toBeUndefined();
    expect(parseSuite({ command: 'npm test', files: [file] })).toBeUndefined();
    expect(parseSuite({ command: `${command}\nrm -rf x`, files: [file] })).toBeUndefined();
  });
});

describe('suiteBroken', () => {
  it('tells a suite that never ran from one that failed', () => {
    expect(suiteBroken('No test files found, exiting with code 1')).toBe(true);
    expect(suiteBroken('not ok 1 - fulfil ships reserved stock')).toBe(false);
  });
});
