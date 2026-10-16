import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  efficiency,
  IDLE_GAP_MS,
  readRunEvents,
  type RunEvent,
} from '../../../bench/efficiency.ts';
import { efficiencyCells, summaryRow } from '../../../bench/results.ts';
import type { TaskRunResult } from '../../../bench/types.ts';

const turn = (ts: number, ms = 1_000, tokens = { uncached: 100, cacheWrite: 0, cacheRead: 900 }) =>
  ({ ts, type: 'turn', ms, tokens }) as RunEvent;
const tool = (ts: number, name: string, ms = 5) =>
  ({ ts, type: 'tool.call', tool: name, ms }) as RunEvent;

describe('efficiency', () => {
  it('is undefined for a run with no events', () => {
    expect(efficiency([])).toBeUndefined();
  });

  it('counts tool calls per turn and turns that asked for several', () => {
    const e = efficiency([
      turn(0),
      tool(10, 'read'),
      tool(11, 'read'),
      tool(12, 'search'),
      turn(2_000),
      tool(2_010, 'bash'),
      turn(4_000),
    ]);
    expect(e).toMatchObject({ turns: 3, tool_calls: 4, calls_per_turn: 2, multi_call_turns: 1 });
  });

  it('measures the bookkeeping share of tool calls', () => {
    const e = efficiency([
      turn(0),
      tool(1, 'todo'),
      tool(2, 'read'),
      turn(1_000),
      tool(1_001, 'running_context'),
      tool(1_002, 'remember'),
      tool(1_003, 'str_replace'),
    ]);
    expect(e?.bookkeeping_share).toBe(0.6);
  });

  it('sums fresh and cached input from turns', () => {
    const e = efficiency([
      turn(0, 1_000, { uncached: 5_000, cacheWrite: 0, cacheRead: 0 }),
      turn(1_000, 1_000, { uncached: 300, cacheWrite: 200, cacheRead: 4_500 }),
    ]);
    expect(e).toMatchObject({ fresh_per_turn: 2_750, cache_share: 0.45 });
  });

  it('adds up gate time from think-loop and cycle gate events', () => {
    const e = efficiency([
      turn(0),
      { ts: 120_000, type: 'loop.gates', ms: 118_000 },
      {
        ts: 200_000,
        type: 'verify.gates',
        gates: [{ durationMs: 50_000 }, { durationMs: 25_000 }],
      },
    ]);
    expect(e?.gate_ms).toBe(193_000);
  });

  it('does not count a long model call, tool run or gate as idle', () => {
    const e = efficiency([
      turn(0),
      turn(300_000, 299_000),
      tool(900_000, 'bash', 599_000),
      { ts: 1_500_000, type: 'loop.gates', ms: 599_500 },
    ]);
    expect(e?.idle_ms).toBe(0);
  });

  it('counts uncovered gaps over the threshold as idle, short ones not', () => {
    const e = efficiency([
      turn(0),
      turn(IDLE_GAP_MS, 1_000),
      { ts: IDLE_GAP_MS + 200_000, type: 'phase' },
    ]);
    expect(e?.idle_ms).toBe(200_000);
  });

  it('counts a quiet tail before the bench killed the run', () => {
    const e = efficiency([turn(1_000), tool(1_500, 'read')], { start: 0, end: 1_800_000 });
    expect(e?.idle_ms).toBe(1_800_000 - 1_500);
  });
});

describe('readRunEvents', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps well-formed events and skips broken lines', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omnexx-eff-'));
    await writeFile(
      join(dir, 'events.jsonl'),
      [
        '{"ts":1,"type":"turn"}',
        'not json',
        '{"type":"no-ts"}',
        '{"ts":2,"type":"tool.call"}',
        '',
      ].join('\n'),
    );
    expect((await readRunEvents(dir)).map((e) => e.type)).toEqual(['turn', 'tool.call']);
  });

  it('is empty when there is no log', async () => {
    expect(await readRunEvents(join(tmpdir(), 'omnexx-eff-missing'))).toEqual([]);
  });
});

describe('results table', () => {
  const row = (agent: string, resolved: boolean, eff?: TaskRunResult['metrics']['efficiency']) =>
    ({
      taskId: 't',
      suite: 's',
      agent,
      metrics: {
        resolved,
        usd: 0,
        tokens_in: 10,
        tokens_out: 1,
        cached: 5,
        wall_ms: 10_000,
        interventions: resolved ? 0 : 1,
        ...(eff ? { efficiency: eff } : {}),
      },
      startedAt: '',
      finishedAt: '',
    }) as TaskRunResult;
  const eff = {
    turns: 10,
    tool_calls: 20,
    calls_per_turn: 2,
    multi_call_turns: 6,
    bookkeeping_share: 0.1,
    gate_ms: 4_000,
    idle_ms: 0,
    fresh_per_turn: 1_200,
    cache_share: 0.9,
  };

  it('shows "-" for a harness without events', () => {
    expect(efficiencyCells(undefined).every((c) => c === '-')).toBe(true);
  });

  it('summarises one agent only, with its own resolved count', () => {
    const line = summaryRow('omnexx', [row('omnexx', true, eff), row('omnexx', false, eff)]);
    expect(line).toContain('| omnexx | 1/2 |');
    expect(line).toContain('| 2.00 |');
    expect(line).toContain('| 10% |');
  });
});
