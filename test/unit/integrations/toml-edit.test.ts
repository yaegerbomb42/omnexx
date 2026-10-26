import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { mergeTableKeys, setTable } from '../../../src/integrations/toml-edit.js';

describe('mergeTableKeys', () => {
  it('creates a missing table, like setTable', () => {
    const next = mergeTableKeys('', ['models'], { worker: 'anthropic:sonnet' });
    expect(parse(next)).toEqual({ models: { worker: 'anthropic:sonnet' } });
  });

  it('adds keys to an existing table while keeping its comments, order and other keys', () => {
    const raw = [
      '# top comment',
      '[models]',
      '# worker is the main role',
      'planner = "anthropic:opus"',
      'worker = "anthropic:sonnet"',
      '',
      '[budget]',
      'max_usd = 50',
    ].join('\n');
    const next = mergeTableKeys(raw, ['models'], { cheap: 'anthropic:haiku' });
    expect(next).toContain('# top comment');
    expect(next).toContain('planner = "anthropic:opus"');
    expect(next).toContain('cheap = "anthropic:haiku"');
    const parsed = parse(next) as { models: { cheap: string }; budget: { max_usd: number } };
    expect(parsed.models.cheap).toBe('anthropic:haiku');
    expect(parsed.budget.max_usd).toBe(50);
  });

  it('replaces an existing scalar value', () => {
    const raw = '[models]\nworker = "anthropic:sonnet"\n';
    const next = mergeTableKeys(raw, ['models'], { worker: 'anthropic:opus' });
    expect(parse(next)).toEqual({ models: { worker: 'anthropic:opus' } });
  });

  it('replaces a multiline array value', () => {
    const raw = '[policy]\nenv_passthrough = [\n  "A",\n  "B",\n]\n';
    const next = mergeTableKeys(raw, ['policy'], {
      env_passthrough: ['A', 'B', 'C'],
    });
    const parsed = parse(next) as { policy: { env_passthrough: string[] } };
    expect(parsed.policy.env_passthrough).toEqual(['A', 'B', 'C']);
  });

  it('ignores nested sub-tables when inserting keys (they are not part of the body)', () => {
    const raw = [
      '[models]',
      'planner = "anthropic:opus"',
      '',
      '[models.profiles."anthropic:opus"]',
      'quality = "high"',
    ].join('\n');
    const next = mergeTableKeys(raw, ['models'], { worker: 'anthropic:sonnet' });
    const parsed = parse(next) as {
      models: { planner: string; worker: string; profiles: Record<string, { quality: string }> };
    };
    expect(parsed.models.worker).toBe('anthropic:sonnet');
    expect(parsed.models.profiles['anthropic:opus']?.quality).toBe('high');
  });

  it('throws on malformed input instead of writing a broken config', () => {
    expect(() => mergeTableKeys('not toml [', ['models'], { worker: 'x' })).toThrow();
    expect(() => setTable('not toml [', ['models'], { worker: 'x' })).toThrow();
  });
});
