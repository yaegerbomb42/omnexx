import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDLE_GAP_MS, type RunEvent } from '../../../bench/efficiency.ts';
import { MAX_FINDINGS, diagnoseRun } from '../../../src/telemetry/run-diagnosis.js';
import { cli } from '../../support/cli.js';
import { isolatedEnv, tempDir, tempRepo } from '../../support/tmp.js';

function turn(
  n: number,
  ts: number,
  ms = 1_000,
  tokens?: { cacheRead: number; uncached: number },
): RunEvent {
  const event: RunEvent = { ts, type: 'turn', turn: n, ms };
  if (tokens) event.tokens = tokens;
  return event;
}

function tool(
  ts: number,
  name: string,
  input?: Record<string, unknown> | string,
  extra: Record<string, unknown> = {},
): RunEvent {
  const event: RunEvent = { ts, type: 'tool.call', tool: name, ms: 5, ...extra };
  if (input !== undefined) event.input = input;
  return event;
}

describe('diagnoseRun', () => {
  it('names a single-call explore, a repeated read, and idle, and keeps five', () => {
    const secondRead = 2_020;
    const idleOpen = IDLE_GAP_MS + 120_000;
    const turn3 = secondRead + 1_000 + idleOpen;
    const events: RunEvent[] = [
      turn(1, 0),
      tool(10, 'read', { path: 'a.ts', start: 1, end: 20 }),
      turn(2, 2_000),
      tool(2_010, 'read', JSON.stringify({ path: 'a.ts', start: 1, end: 20 })),
      tool(secondRead, 'search', { pattern: 'Widget' }),
      turn(3, turn3),
      tool(turn3 + 10, 'read', { path: 'c.ts', start: 1, end: 5 }),
      tool(turn3 + 20, 'bash', { command: 'ls' }),
      ...['curl-a', 'curl-b', 'curl-c', 'curl-d'].map((command, i): RunEvent => ({
        ts: turn3 + 30 + i,
        type: 'tool.denied',
        tool: 'bash',
        command,
        reason: 'network is off',
      })),
    ];

    const findings = diagnoseRun(events);
    expect(findings).toHaveLength(MAX_FINDINGS);
    expect(findings.map((f) => f.kind)).toEqual([
      'idle',
      'repeated-read',
      'single-call-explore',
      'denied',
      'denied',
    ]);
    expect(findings[0]).toMatchObject({
      turns: [2, 3],
      hint: '180s idle: a gap over 60s that no turn, tool, or gate covers.',
    });
    expect(findings[1]).toMatchObject({
      turns: [1, 2],
      hint: 'a.ts:1-20 was read again with no edit in between. Reuse the earlier result.',
    });
    expect(findings[2]).toMatchObject({
      turns: [1],
      hint: 'One read call on this turn. Send every read, search, and outline you need in the same turn.',
    });
    expect(findings[3]?.hint).toContain('curl-a');
    expect(findings[4]?.hint).toContain('curl-b');
    expect(findings.some((f) => f.hint.includes('curl-c') || f.hint.includes('curl-d'))).toBe(
      false,
    );
  });

  it('reports nothing when the run has none of these problems', () => {
    const events: RunEvent[] = [
      turn(1, 0, 1_000, { cacheRead: 1_000, uncached: 200 }),
      tool(100, 'read', { path: 'a.ts', start: 1, end: 10 }),
      tool(200, 'search', { pattern: 'x' }),
      tool(300, 'todo', {}),
      turn(2, 2_000, 1_000, { cacheRead: 960, uncached: 100 }),
      tool(2_100, 'read', { path: 'b.ts' }),
      tool(2_200, 'bash', { command: 'ls' }),
      tool(
        2_300,
        'str_replace',
        { path: 'a.ts', old_str: 'x', new_str: 'y' },
        {
          isError: true,
          error: 'edit 1: old_str found 0 times in a.ts',
        },
      ),
      turn(3, 40_000, 1_000, { cacheRead: 900, uncached: 80 }),
      tool(40_100, 'bash', { command: 'pwd' }),
      tool(40_200, 'read', { path: 'a.ts', start: 1, end: 40 }),
      tool(40_300, 'str_replace', { path: 'a.ts', old_str: 'y', new_str: 'z' }),
    ];
    expect(diagnoseRun(events)).toEqual([]);
  });

  it('names cache dips, denials, edit misses, bookkeeping, and gate time', () => {
    expect(
      diagnoseRun([
        turn(1, 0, 500, { cacheRead: 1_000, uncached: 0 }),
        turn(2, 1_000, 500, { cacheRead: 100, uncached: 0 }),
      ]).map((f) => ({ kind: f.kind, turns: f.turns })),
    ).toEqual([{ kind: 'cache-dip', turns: [2] }]);

    const denied = diagnoseRun([
      turn(1, 0),
      {
        ts: 20,
        type: 'tool.denied',
        tool: 'bash',
        command: 'curl x',
        reason: 'network is off',
      },
      tool(
        30,
        'bash',
        { command: 'curl x' },
        {
          isError: true,
          error: 'refused by policy (network): network is off',
        },
      ),
    ]);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ kind: 'denied', turns: [1] });
    expect(denied[0]?.hint).toContain('curl x');

    const missed = diagnoseRun([
      turn(4, 0),
      tool(
        10,
        'str_replace',
        { path: 'a.ts' },
        {
          isError: true,
          error: 'edit 1: old_str found 0 times in a.ts',
        },
      ),
      tool(
        20,
        'str_replace',
        { path: 'a.ts' },
        {
          isError: true,
          error: 'edit 1: old_str found 0 times in a.ts',
        },
      ),
    ]);
    expect(missed.map((f) => f.kind)).toEqual(['edit-miss']);
    expect(missed[0]?.turns).toEqual([4]);
    expect(missed[0]?.hint).toContain('no separate edit-miss event');

    const named = diagnoseRun([
      turn(2, 0),
      tool(10, 'str_replace', { path: 'a.ts' }, { isError: true, error: 'old_str not found' }),
    ]);
    expect(named).toHaveLength(1);
    expect(named[0]?.hint).toContain('not found');

    const notes = diagnoseRun([
      turn(1, 0),
      tool(10, 'todo', {}),
      tool(20, 'remember', {}),
      tool(30, 'context', {}),
      tool(40, 'read', { path: 'a.ts' }),
    ]);
    expect(notes.map((f) => f.kind)).toEqual(['bookkeeping']);
    expect(notes[0]?.turns).toEqual([1]);

    const gates = diagnoseRun([turn(1, 0), { ts: 50_000, type: 'loop.gates', ms: 40_000 }]);
    expect(gates.map((f) => f.kind)).toEqual(['gate-time']);
    expect(gates[0]?.turns).toEqual([1]);
    expect(gates[0]?.hint).toContain('80%');
  });
});

describe('omnexx doctor --run', () => {
  it('prints a finished run from an id or an events.jsonl path and exits 0', async () => {
    const env = await isolatedEnv();
    const cwd = await tempRepo();
    const id = 'r_20260101_0000_abcd';
    const home = env.OMNEXX_HOME ?? '';
    const dir = join(home, 'runs', id);
    await mkdir(dir, { recursive: true });
    const events: RunEvent[] = [turn(1, 0), tool(10, 'read', { path: 'a.ts', start: 1, end: 5 })];
    const body = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    await writeFile(join(dir, 'events.jsonl'), body);

    const byId = await cli(['doctor', '--run', id], { cwd, env });
    expect(byId.code).toBe(0);
    expect(byId.stdout).toContain('1 single-call-explore turns 1 ');

    const byPath = await cli(['doctor', '--run', join(dir, 'events.jsonl'), '--json'], {
      cwd,
      env,
    });
    expect(byPath.code).toBe(0);
    const parsed = JSON.parse(byPath.stdout) as { findings: { rank: number; kind: string }[] };
    expect(parsed.findings).toEqual([
      expect.objectContaining({ rank: 1, kind: 'single-call-explore' }),
    ]);

    const byDir = await cli(['doctor', '--run', dir], { cwd, env });
    expect(byDir.code).toBe(0);
    expect(byDir.stdout).toContain('single-call-explore');

    const missing = await cli(['doctor', '--run', 'r_20260101_0000_ffff'], { cwd, env });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no events');
  });

  it('says when a run has no findings', async () => {
    const dir = await tempDir();
    const file = join(dir, 'events.jsonl');
    await writeFile(
      file,
      `${JSON.stringify(turn(1, 0))}\n${JSON.stringify(tool(10, 'read', { path: 'a.ts' }))}\n${JSON.stringify(tool(20, 'search', { pattern: 'a' }))}\n`,
    );
    const r = await cli(['doctor', '--run', file], { cwd: dir, env: await isolatedEnv() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('no findings');
  });
});
