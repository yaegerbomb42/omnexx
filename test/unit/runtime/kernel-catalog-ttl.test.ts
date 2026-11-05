import { describe, expect, it } from 'vitest';
import { CapabilityCatalog } from '../../../src/runtime/kernel/catalog.js';

const skill = (id: string) => ({ id, kind: 'skill' as const, name: id, description: `pdf ${id}` });

describe('bug #16: remote SkillMD hits expire', () => {
  it('evicts ephemeral entries after the TTL but keeps permanent and mounted ones', () => {
    const c = new CapabilityCatalog();
    c.load([skill('local:skill:a')]);
    c.upsert([skill('registry:skill:b'), skill('registry:skill:c')], { ttlMs: 1000, now: 0 });
    c.mount('registry:skill:c');
    expect(c.pruneExpired(500)).toBe(0);
    expect(c.pruneExpired(2000)).toBe(1);
    expect(c.has('registry:skill:b')).toBe(false);
    expect(c.has('registry:skill:c')).toBe(true);
    expect(c.has('local:skill:a')).toBe(true);
  });

  it('never demotes a permanent entry to ephemeral', () => {
    const c = new CapabilityCatalog();
    c.load([skill('registry:skill:x')]);
    c.upsert([skill('registry:skill:x')], { ttlMs: 1, now: 0 });
    expect(c.pruneExpired(10)).toBe(0);
    expect(c.has('registry:skill:x')).toBe(true);
  });
});
