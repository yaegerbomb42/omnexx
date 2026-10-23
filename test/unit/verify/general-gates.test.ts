import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { gateSchema } from '../../../src/config/schema.js';
import { antiCheat } from '../../../src/verify/anticheat.js';
import { runGate, type GateRunContext } from '../../../src/verify/gates.js';
import { specTestsWanted } from '../../../src/verify/spec-tests.js';
import { tempDir } from '../../support/tmp.js';

async function ctx(): Promise<{ dir: string; gateCtx: GateRunContext }> {
  const dir = await tempDir();
  return {
    dir,
    gateCtx: {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      logsDir: dir,
      label: 'c1',
      maxCmdTimeoutMs: 20_000,
      redact: (s) => s,
    },
  };
}

describe('exists gates (artifact checks)', () => {
  it('passes when the artifact is there, fails with a named failure when it is not', async () => {
    const { dir, gateCtx } = await ctx();
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'report.md'), '# Report\n');
    const gate = gateSchema.parse({ name: 'report', kind: 'exists', path: 'out/report.md' });

    const hit = await runGate(gate, gateCtx);
    expect(hit.exitCode).toBe(0);
    expect(hit.failures).toEqual([]);

    const miss = await runGate(
      gateSchema.parse({ name: 'data', kind: 'exists', path: 'out/data.csv' }),
      gateCtx,
    );
    expect(miss.exitCode).toBe(1);
    expect(miss.failures).toEqual([
      { id: 'data:exists', message: 'expected out/data.csv to exist' },
    ]);
  });

  it('a directory counts as existing', async () => {
    const { gateCtx } = await ctx();
    const gate = gateSchema.parse({ name: 'dir', kind: 'exists', path: '.' });
    expect((await runGate(gate, gateCtx)).exitCode).toBe(0);
  });
});

describe('gate schema validation', () => {
  it('an exists gate needs a path; command and browser gates need a run', () => {
    expect(() => gateSchema.parse({ name: 'x', kind: 'exists' })).toThrow(/path/);
    expect(() => gateSchema.parse({ name: 'x' })).toThrow(/run/);
    expect(gateSchema.parse({ name: 'x', kind: 'exists', path: 'a.md' }).run).toBe('');
    expect(gateSchema.parse({ name: 'x', run: 'npm test' }).kind).toBe('command');
  });

  it('an exists gate parses from a TOML-shaped config', () => {
    const config = defaultConfig({
      gates: [{ name: 'report', kind: 'exists', path: 'REPORT.md' }],
    });
    expect(config.gates[0]).toMatchObject({ name: 'report', kind: 'exists', path: 'REPORT.md' });
  });
});

describe('spec tests in the general domain', () => {
  const LIST = Array.from({ length: 6 }, (_, i) => `- requirement ${i + 1}`).join('\n');

  it('never wanted in general, even with spec_tests on and a long goal', () => {
    const config = defaultConfig({
      execution: { domain: 'general' },
      review: { spec_tests: 'on' },
    });
    expect(specTestsWanted(config, `Build it:\n${LIST}`, false)).toBe(false);
  });

  it('still wanted in swe under the same settings', () => {
    const config = defaultConfig({ review: { spec_tests: 'on' } });
    expect(specTestsWanted(config, `Build it:\n${LIST}`, false)).toBe(true);
  });
});

describe('anti-cheat in the general domain', () => {
  const base = {
    protectedPatterns: ['omnexx.toml', '.github/**'],
    allow: [],
    baseline: undefined,
    results: [],
  };
  const weakening = {
    changes: [{ status: 'D' as const, path: 'test/a.test.js', added: 0, removed: 5 }],
    patch: '+++ b/notes.md\n+see // eslint-disable for details\n',
  };

  it('swe flags the deleted test and the skip marker', () => {
    const v = antiCheat({ ...base, ...weakening });
    expect(v.map((x) => x.rule)).toEqual(['deleted-test', 'skip-marker']);
  });

  it('general ignores test-weakening rules but keeps protected paths', () => {
    const v = antiCheat({
      ...base,
      ...weakening,
      changes: [
        ...weakening.changes,
        { status: 'M' as const, path: 'omnexx.toml', added: 1, removed: 0 },
      ],
      domain: 'general',
    });
    expect(v.map((x) => x.rule)).toEqual(['protected-path']);
  });
});
