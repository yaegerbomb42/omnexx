import { describe, expect, it } from 'vitest';
import { MASK, Redactor } from '../../../src/security/redact.js';
import { secretCorpus, secretValues } from '../../support/secrets.js';

describe('Redactor', () => {
  it('masks every token in the corpus by pattern alone', () => {
    const r = new Redactor();
    for (const [name, secret] of Object.entries(secretCorpus())) {
      const out = r.text(`before ${secret} after`);
      expect(out, name).not.toContain(secret);
      expect(out).toContain(MASK);
      expect(out).toMatch(/^before .* after$/s);
    }
  });

  it('masks exact values of secret-looking env vars, longest first', () => {
    const r = Redactor.fromEnv({
      DB_PASSWORD: 'hunter2hunter2',
      MY_TOKEN: 'hunter2hunter2-and-more',
      PATH: '/usr/bin:/bin',
    });
    expect(r.text('pw=hunter2hunter2-and-more')).toBe(`pw=${MASK}`);
    expect(r.text('pw=hunter2hunter2')).toBe(`pw=${MASK}`);
    expect(r.text('/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });

  it('ignores very short values to avoid masking everything', () => {
    expect(new Redactor(['abc']).text('abc abc')).toBe('abc abc');
  });

  it('deep-redacts objects and arrays, keeping keys and non-strings', () => {
    const s = secretCorpus().github;
    const out = new Redactor().value({ a: [s, 1, null], b: { c: `x ${s}` }, n: 3, t: true });
    expect(JSON.stringify(out)).not.toContain(s);
    expect(out).toMatchObject({ n: 3, t: true, a: [MASK, 1, null] });
  });

  it('withValues extends the set', () => {
    expect(new Redactor().withValues(['supersecretvalue']).text('supersecretvalue')).toBe(MASK);
  });

  it('corpus helper exposes every value', () => {
    expect(secretValues()).toHaveLength(Object.keys(secretCorpus()).length);
  });
});
