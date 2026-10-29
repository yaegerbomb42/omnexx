import { describe, expect, it } from 'vitest';
import {
  extractSymbols,
  findBraceEndLine,
  findPythonEndLine,
  renderOutline,
} from '../../../src/tools/outline.js';

describe('AST & symbol-level outline reader with line spans', () => {
  it('calculates balanced curly brace end lines for TypeScript/JavaScript', () => {
    const lines = [
      'export function calculateSum(a: number, b: number): number {',
      '  const res = a + b;',
      '  return res;',
      '}',
      'export const PI = 3.14;',
    ];
    expect(findBraceEndLine(lines, 1)).toBe(4);
  });

  it('calculates Python block boundaries via indentation', () => {
    const lines = [
      'def compute_discount(price, pct):',
      '    discount = price * pct',
      '    if discount < 0:',
      '        return 0',
      '    return discount',
      '',
      'def next_function():',
      '    pass',
    ];
    expect(findPythonEndLine(lines, 1)).toBe(5);
    expect(findPythonEndLine(lines, 7)).toBe(8);
  });

  it('extracts arrow functions and distinguishes them from regular consts', () => {
    const code = [
      'export const computeTotal = (items: Item[]): number => {',
      '  return items.length * 10;',
      '};',
      'export const TAX_RATE = 0.08;',
      'const localHelper = async (x: string) => {',
      '  return x.trim();',
      '};',
    ].join('\n');

    const symbols = extractSymbols(code);
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'function:computeTotal',
      'const:TAX_RATE',
      'function:localHelper',
    ]);
    expect(symbols[0]?.line).toBe(1);
    expect(symbols[0]?.endLine).toBe(3);
    expect(symbols[2]?.line).toBe(5);
    expect(symbols[2]?.endLine).toBe(7);
  });

  it('renders outline with line spans when available', () => {
    const code = [
      'export function greet(): string {',
      '  return "hello";',
      '}',
      'export class Greeter {',
      '  say(): void {}',
      '}',
    ].join('\n');

    const symbols = extractSymbols(code);
    const rendered = renderOutline(symbols, 6);
    expect(rendered).toContain('6 lines');
    expect(rendered).toContain('1  function greet (lines 1-3)');
    expect(rendered).toContain('4  class Greeter (lines 4-6)');
  });
});
