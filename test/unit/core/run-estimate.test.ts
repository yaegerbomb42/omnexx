import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  estimateRun,
  fmtDuration,
  fmtTokenCount,
  formatEstimate,
  formatRemaining,
  remainingMs,
  type RunEstimate,
} from '../../../src/core/run-estimate.js';
import {
  appendRunSample,
  loadRunHistory,
  MAX_RUN_SAMPLES,
  recordRun,
  type RunSample,
} from '../../../src/core/run-history.js';
import { recordFinishedRun, sampleForRun } from '../../../src/core/run-estimate-io.js';
import { stateSchema } from '../../../src/core/run-store.js';
import type { OmnexxPaths } from '../../../src/core/paths.js';
import { tempDir } from '../../support/tmp.js';

const MIN = 60_000;

function sample(over: Partial<RunSample> = {}): RunSample {
  return {
    at: 1,
    kind: 'run',
    model: 'anthropic:sonnet',
    goalChars: 100,
    planned: false,
    nodes: 1,
    repoFiles: 50,
    wallMs: 3 * MIN,
    freshTokens: 30_000,
    cachedTokens: 10_000,
    usd: 0.02,
    ...over,
  };
}

const query = { kind: 'run' as const, model: 'anthropic:sonnet', goalChars: 100, repoFiles: 50 };

describe('estimateRun', () => {
  it('has no estimate without past work of the same kind', () => {
    expect(estimateRun([], query)).toBeUndefined();
    expect(estimateRun([sample({ kind: 'chat' })], query)).toBeUndefined();
  });

  it('reports the medians of the nearest similar runs', () => {
    const history = [sample(), sample({ wallMs: 3.2 * MIN }), sample({ wallMs: 2.8 * MIN })];
    const e = estimateRun(history, query);
    expect(e?.basis).toBe(3);
    expect(e?.wallMs.mid).toBe(3 * MIN);
    expect(e?.tokens.mid).toBe(40_000);
    expect(e?.uncertain).toBe(false);
    expect(formatEstimate(e)).toBe('est. ~3 min, ~40k tokens, ~$0.02 (3 similar runs)');
  });

  it('picks the closest goal sizes over distant ones', () => {
    const history = [
      ...Array.from({ length: 5 }, () => sample({ goalChars: 5_000, wallMs: 60 * MIN })),
      ...Array.from({ length: 5 }, () => sample({ goalChars: 90, wallMs: 2 * MIN })),
    ];
    expect(estimateRun(history, query)?.wallMs.mid).toBe(2 * MIN);
    expect(estimateRun(history, { ...query, goalChars: 4_000 })?.wallMs.mid).toBe(60 * MIN);
  });

  it('prefers the same model and path once there are enough of them', () => {
    const others = Array.from({ length: 5 }, () => sample({ model: 'x:y', wallMs: 10 * MIN }));
    const mine = Array.from({ length: 3 }, () => sample({ wallMs: 2 * MIN }));
    expect(estimateRun([...others, ...mine], query)?.wallMs.mid).toBe(2 * MIN);
    // Too few on this model: every model counts.
    expect(estimateRun([...others, sample({ wallMs: 2 * MIN })], query)?.basis).toBe(5);
    const planned = Array.from({ length: 3 }, () => sample({ planned: true, wallMs: 20 * MIN }));
    expect(estimateRun([...mine, ...planned], { ...query, planned: true })?.wallMs.mid).toBe(
      20 * MIN,
    );
  });

  it('shows a range when the sample is small or spread wide', () => {
    const one = estimateRun([sample()], query);
    expect(one?.uncertain).toBe(true);
    expect(formatEstimate(one)).toBe('est. ~3 min, ~40k tokens, ~$0.02 (1 similar run)');
    const wide = estimateRun(
      [2, 3, 4, 8, 9].map((m) => sample({ wallMs: m * MIN })),
      query,
    );
    expect(wide?.uncertain).toBe(true);
    expect(formatEstimate(wide)).toMatch(/^est\. 3–8 min,/);
  });

  it('says so with no history', () => {
    expect(formatEstimate(undefined)).toBe('no history yet');
  });
});

describe('estimate formatting', () => {
  it('formats durations, tokens and tiny costs', () => {
    expect(fmtDuration(400)).toBe('1s');
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(80 * MIN)).toBe('80 min');
    expect(fmtDuration(3 * 60 * MIN)).toBe('3 h');
    expect(fmtDuration(150 * MIN)).toBe('2.5 h');
    expect(fmtTokenCount(800)).toBe('800');
    expect(fmtTokenCount(1_500_000)).toBe('1.5M');
    expect(formatEstimate(estimateRun([sample({ usd: 0.001 })], query))).toContain('<$0.01');
  });
});

describe('time left', () => {
  const est: RunEstimate = {
    basis: 5,
    wallMs: { mid: 10 * MIN, lo: 9 * MIN, hi: 11 * MIN },
    tokens: { mid: 1, lo: 1, hi: 1 },
    usd: { mid: 0, lo: 0, hi: 0 },
    uncertain: false,
  };

  it('uses the estimate before any node is done', () => {
    expect(remainingMs(est, { elapsedMs: 4 * MIN, done: 0, total: 0 })).toBe(6 * MIN);
    expect(formatRemaining(est, { elapsedMs: 4 * MIN, done: 0, total: 0 })).toBe('~6 min left');
  });

  it('blends the pace so far with the estimate as nodes finish', () => {
    // 2 of 4 done in 4 min: the pace says 4 more, the estimate 6; ~5 min left.
    expect(formatRemaining(est, { elapsedMs: 4 * MIN, done: 2, total: 4 })).toBe('~5 min left');
    expect(formatRemaining(undefined, { elapsedMs: 4 * MIN, done: 2, total: 4 })).toBe(
      '~4 min left',
    );
  });

  it('handles overruns, finished plans and no information', () => {
    expect(formatRemaining(est, { elapsedMs: 12 * MIN, done: 0, total: 3 })).toBe(
      'taking longer than usual',
    );
    expect(formatRemaining(est, { elapsedMs: 5 * MIN, done: 3, total: 3 })).toBe('finishing up');
    expect(formatRemaining(undefined, { elapsedMs: 1, done: 0, total: 3 })).toBeUndefined();
  });
});

describe('run history', () => {
  it('records valid samples only, keeps the newest, and never mutates', () => {
    const empty: RunSample[] = [];
    expect(recordRun(empty, sample({ wallMs: 0 }))).toBe(empty);
    let h = recordRun(empty, sample());
    for (let i = 0; i < MAX_RUN_SAMPLES + 3; i++) h = recordRun(h, sample({ at: i }));
    expect(h).toHaveLength(MAX_RUN_SAMPLES);
    expect(h.at(-1)?.at).toBe(MAX_RUN_SAMPLES + 2);
    expect(empty).toEqual([]);
  });

  it('saves and loads, skipping broken entries and files', async () => {
    const file = join(await tempDir(), 'run-history.json');
    expect(await loadRunHistory(file)).toEqual([]);
    await appendRunSample(file, sample());
    expect(await loadRunHistory(file)).toEqual([sample()]);
    await writeFile(file, JSON.stringify([sample(), { nope: 1 }]));
    expect(await loadRunHistory(file)).toEqual([sample()]);
    await writeFile(file, '{broken');
    expect(await loadRunHistory(file)).toEqual([]);
  });

  it('builds a sample from a finished run and leaves stopped runs out', async () => {
    const state = stateSchema.parse({
      version: 1,
      runId: 'r',
      repoRoot: '/r',
      repoName: 'r',
      worktree: '/w',
      branch: 'b',
      startRef: 's',
      lastGreen: 's',
      phase: 'done',
      status: 'finished',
      cycle: 2,
      startedAt: 0,
      updatedAt: 0,
      activeMs: 90_000,
      goalHash: 'h',
      fastPath: 'tried',
      spend: { usd: 0.5, tokens: { uncached: 100, cacheWrite: 20, cacheRead: 300, output: 50 } },
    });
    const s = sampleForRun(state, undefined, { model: 'm', goalChars: 10, repoFiles: 7, at: 5 });
    expect(s).toMatchObject({
      kind: 'run',
      planned: false,
      nodes: 0,
      wallMs: 90_000,
      freshTokens: 170,
      cachedTokens: 300,
      usd: 0.5,
    });
    const dir = await tempDir();
    const paths = { configHome: dir } as OmnexxPaths;
    await recordFinishedRun(paths, s, 'user-stop');
    expect(await loadRunHistory(join(dir, 'run-history.json'))).toEqual([]);
    await recordFinishedRun(paths, s, 'finished');
    expect(await loadRunHistory(join(dir, 'run-history.json'))).toHaveLength(1);
  });
});
