import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { brand } from '../../../src/cli/brand.js';
import type { OmnexxEvent } from '../../../src/core/events.js';
import {
  cacheHitRate,
  emptyTelemetry,
  fold,
  tokensPerCommit,
} from '../../../src/telemetry/aggregate.js';
import { EventTail, LiveFeed, statusLine } from '../../../src/telemetry/feed.js';
import {
  fmtMs,
  fmtTokens,
  humanize,
  verbosityFrom,
  type Verbosity,
} from '../../../src/telemetry/humanize.js';

const plain = brand({ env: {}, isTTY: false });
const ev = (type: string, data: Record<string, unknown> = {}, cycle = 3): OmnexxEvent => ({
  ts: Date.UTC(2026, 9, 5, 12, 4, 31),
  runId: 'r1',
  cycle,
  type,
  ...data,
});
const h = (e: OmnexxEvent, verbosity: Verbosity = 'verbose'): string | undefined =>
  humanize(e, { brand: plain, verbosity, utc: true });

describe('humanize', () => {
  it('renders the core feed lines', () => {
    expect(
      h(ev('tool.call', { tool: 'read', input: '{"path":"src/a.ts","start":40,"end":120}' })),
    ).toBe('12:04:31 ▸ read     src/a.ts:40-120');
    expect(
      h(
        ev('tool.call', { tool: 'bash', input: '{"command":"npm test"}', ms: 6100, isError: true }),
      ),
    ).toBe('12:04:31 ✗ bash     npm test  6.1s  ✗');
    expect(
      h(
        ev('tool.call', {
          tool: 'write_plan',
          input: '{}',
          isError: true,
          error: '\nplan rejected: task M1.T01 must live under milestone M2\nmore',
        }),
      ),
    ).toMatch(/✗ plan rejected: task M1\.T01 must live under milestone M2$/);
    expect(
      h(ev('tool.call', { tool: 'multi_edit', input: '{"path":"x.ts","edits":[{},{}]}' })),
    ).toBe('12:04:31 ▸ edit     x.ts (2 edits)');
    expect(
      h(
        ev('verify.gates', {
          gates: [
            { gate: 'test', exitCode: 0, tests: { passed: 214, total: 214 }, durationMs: 6100 },
            { gate: 'lint', exitCode: 1, newFailures: 2, durationMs: 900 },
          ],
        }),
      ),
    ).toBe('12:04:31 ✗ gates    test ✓ 214/214 (6.1s)  lint ✗ +2 new (900ms)');
    expect(
      h(
        ev('commit', {
          sha: '3f2a1c9deadbeef',
          task: 'M1.T02',
          diff: { files: 2, added: 12, removed: 3 },
        }),
      ),
    ).toBe('12:04:31 ✓ commit   3f2a1c9  M1.T02  2 files +12 −3');
    expect(
      h(
        ev('route.decision', {
          action: 'edit-small',
          model: 'groq:llama',
          by: 'nimble',
          probability: 0.91,
          ms: 48,
        }),
      ),
    ).toBe('12:04:31 · route    edit-small → groq:llama  nimble p=0.91  48ms');
    expect(
      h(
        ev('turn', {
          model: 'm',
          provider: 'p',
          tokens: { uncached: 200, cacheWrite: 0, cacheRead: 1800, output: 300 },
          cacheReadShare: 0.9,
          usd: 0.0123,
          ms: 2300,
        }),
      ),
    ).toBe('12:04:31 · model    p:m  in 2.0k out 300 · cache 90% · $0.012 · 2.3s');
  });

  it('renders warn lines for suspect checks, rejected plans and unavailable audits', () => {
    expect(
      h(ev('check.suspect', { task: 'M2.T01', checks: ['npm run lint', 'npm run typecheck'] })),
    ).toBe('12:04:31 ! suspect  M2.T01: checks may be wrong  npm run lint; npm run typecheck');
    expect(h(ev('plan.check_rejected', { reason: 'already_pass', count: 3 }))).toBe(
      '12:04:31 ! plan     3 checks already pass; plan rejected',
    );
    expect(h(ev('plan.check_rejected', { reason: 'broken', count: 1 }))).toBe(
      "12:04:31 ! plan     1 checks can't run; plan rejected",
    );
    expect(h(ev('audit.unavailable', { error: 'HTTP 599: upstream dropped it' }))).toBe(
      '12:04:31 ! audit    no answer: HTTP 599: upstream dropped it',
    );
    expect(h(ev('check.suspect', { task: 'M2.T01', checks: [] }), 'normal')).toBe(
      '12:04:31 ! suspect  M2.T01: checks may be wrong',
    );
  });

  it('filters by verbosity and hides internal events', () => {
    const turn = ev('turn', { tokens: {} });
    expect(h(turn, 'normal')).toBeUndefined();
    expect(h(turn, 'verbose')).toBeDefined();
    expect(h(ev('tool.call', { tool: 'read', input: '{}' }), 'quiet')).toBeUndefined();
    expect(h(ev('commit', { sha: 'abc' }), 'quiet')).toBeDefined();
    expect(h(ev('phase', { phase: 'act' }), 'verbose')).toBeUndefined();
    expect(h(ev('something.new', { a: 1 }), 'normal')).toBeUndefined();
    expect(h(ev('something.new', { a: 1 }), 'debug')).toBe('12:04:31 · something…');
    expect(h(ev('phase', { phase: 'act' }), 'debug')).toBe('12:04:31 · phase    {"phase":"act"}');
  });

  it('survives truncated or odd inputs', () => {
    expect(h(ev('tool.call', { tool: 'read', input: '{"path":"a…' }))).toBe('12:04:31 ▸ read');
    expect(h(ev('tool.call', { tool: 'mcp__x__y', input: '{"q":1}' }))).toContain('{"q":1}');
  });

  it('formats numbers', () => {
    expect([fmtTokens(950), fmtTokens(1_200), fmtTokens(3_400_000)]).toEqual([
      '950',
      '1.2k',
      '3.4M',
    ]);
    expect([fmtMs(48), fmtMs(6_100), fmtMs(125_000), fmtMs(3_900_000)]).toEqual([
      '48ms',
      '6.1s',
      '2m5s',
      '1h5m',
    ]);
    expect(verbosityFrom({ quiet: true, verbose: true })).toBe('verbose');
    expect(verbosityFrom({})).toBe('normal');
  });
});

describe('aggregate', () => {
  it('folds tokens, cache, commits and gates', () => {
    const t = [
      ev('cycle.start', { task: 'M1.T01' }, 1),
      ev('turn', {
        model: 'm',
        provider: 'p',
        tokens: { uncached: 100, cacheWrite: 0, cacheRead: 900, output: 50 },
        usd: 0.5,
      }),
      ev('tool.call', { tool: 'bash', isError: true }),
      ev('verify.gates', { gates: [{ exitCode: 0 }, { exitCode: 1 }] }),
      ev('verify.result', { verdict: 'reject' }),
      ev('commit', { sha: 'abc' }),
    ].reduce(fold, emptyTelemetry());
    expect(t).toMatchObject({
      task: 'M1.T01',
      model: 'm',
      provider: 'p',
      turns: 1,
      usd: 0.5,
      toolErrors: 1,
      gateRuns: 2,
      gatePasses: 1,
      rejects: 1,
      commits: 1,
      cycle: 3,
    });
    expect(cacheHitRate(t)).toBe(0.9);
    expect(tokensPerCommit(t)).toBe(1050);
    expect(statusLine(t, plain, (t.startedAt ?? 0) + 65_000)).toBe(
      'omnexx · 1m5s · cycle 3 · task M1.T01 · m · 1.1k tok · cache 90% · $0.50 · ✓1 ✗1',
    );
  });
});

describe('EventTail and LiveFeed', () => {
  it('reads only new lines, holds a partial line, and restarts after rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-tail-'));
    const path = join(dir, 'events.jsonl');
    const tail = new EventTail(path);
    expect(await tail.read()).toEqual([]);
    await writeFile(path, `${JSON.stringify(ev('commit', { sha: 'a' }))}\n{"ts":1,`);
    expect((await tail.read()).map((e) => e.type)).toEqual(['commit']);
    await appendFile(path, `"runId":"r","cycle":1,"type":"rollback"}\nnot json\n`);
    expect((await tail.read()).map((e) => e.type)).toEqual(['rollback']);
    await writeFile(path, `${JSON.stringify(ev('task.done'))}\n`);
    expect((await tail.read()).map((e) => e.type)).toEqual(['task.done']);
  });

  it('streams humanized lines and clears its footer on stop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnexx-feed-'));
    const path = join(dir, 'events.jsonl');
    await writeFile(path, `${JSON.stringify(ev('commit', { sha: 'abcdef1', task: 'T' }))}\n`);
    const out = new PassThrough();
    let text = '';
    out.on('data', (c: Buffer) => (text += c.toString()));
    const feed = new LiveFeed(new EventTail(path), {
      out,
      brand: plain,
      verbosity: 'normal',
      footer: true,
      now: () => Date.UTC(2026, 9, 5, 12, 5, 31),
    });
    await feed.tick();
    expect(text).toMatch(/✓ commit\s+abcdef1 {2}T\n/);
    expect(text).toMatch(/omnexx · 1m0s · cycle 3.*✓1 ✗0$/);
    await feed.stop();
    await feed.stop();
    expect(text.endsWith('\r\x1b[2K')).toBe(true);
    expect(feed.telemetry.commits).toBe(1);
  });
});
