import { describe, it, expect } from 'vitest';
import {
  anthropicEndpointFromEnv,
  claudeEnv,
  metricsFromClaudeJson,
} from '../../../bench/runners/claude-code.ts';

describe('anthropicEndpointFromEnv', () => {
  it('is undefined when the prefix has no Anthropic URL', () => {
    expect(anthropicEndpointFromEnv({ DS_MODEL: 'm', DS_API_KEY: 'k' }, 'DS')).toBeUndefined();
  });

  it('reads the URL with the shared model and key, or a model override', () => {
    const env = {
      DS_ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
      DS_MODEL: 'chat',
      DS_API_KEY: 'k',
    };
    expect(anthropicEndpointFromEnv(env, 'DS')).toEqual({
      baseUrl: 'https://api.example.com/anthropic',
      model: 'chat',
      apiKey: 'k',
    });
    expect(anthropicEndpointFromEnv({ ...env, DS_ANTHROPIC_MODEL: 'other' }, 'DS')?.model).toBe(
      'other',
    );
  });

  it('throws when the key is missing', () => {
    expect(() =>
      anthropicEndpointFromEnv({ DS_ANTHROPIC_BASE_URL: 'u', DS_MODEL: 'm' }, 'DS'),
    ).toThrow(/DS_API_KEY/);
  });
});

describe('claudeEnv', () => {
  it('pins every model role, isolates config and drops inherited Claude credentials', () => {
    const env = claudeEnv(
      { PATH: '/bin', ANTHROPIC_API_KEY: 'mine', CLAUDE_CONFIG_DIR: '/home/me/.claude' },
      { baseUrl: 'https://e/anthropic', model: 'm', apiKey: 'k' },
      '/tmp/cfg',
    );
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/cfg');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://e/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
    for (const k of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
    ]) {
      expect(env[k]).toBe('m');
    }
  });
});

describe('metricsFromClaudeJson', () => {
  it('reads usage, cost and turns from the last line', () => {
    const line = JSON.stringify({
      total_cost_usd: 0.5,
      num_turns: 7,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
        output_tokens: 40,
      },
    });
    expect(metricsFromClaudeJson(`noise\n${line}\n`)).toEqual({
      resolved: false,
      usd: 0.5,
      tokens_in: 120,
      tokens_out: 40,
      cached: 300,
      requests: 7,
    });
  });

  it('returns zeros for unparseable output', () => {
    expect(metricsFromClaudeJson('not json')).toEqual({
      resolved: false,
      usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      cached: 0,
    });
  });
});
