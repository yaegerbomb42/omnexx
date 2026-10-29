import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';

describe('[tools] discovery default', () => {
  it('is lazy by default, full on request, and the legacy lazy_tools stays off', () => {
    expect(defaultConfig().tools.discovery).toBe('lazy');
    expect(defaultConfig({ tools: { discovery: 'full' } }).tools.discovery).toBe('full');
    expect(defaultConfig().context.lazy_tools).toBe(false);
  });
});
