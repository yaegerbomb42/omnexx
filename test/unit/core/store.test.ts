import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, readTextOr, writeFileAtomic } from '../../../src/core/atomic.js';
import { EventLog, readEvents } from '../../../src/core/events.js';
import { applyRemember, renderNotes } from '../../../src/core/notes.js';
import { resolvePaths } from '../../../src/core/paths.js';
import { newRunId, RUN_ID_RE } from '../../../src/core/run-id.js';
import { listRunIds, RunStore, sha256, type RunState } from '../../../src/core/run-store.js';
import { Redactor } from '../../../src/security/redact.js';
import { secretCorpus } from '../../support/secrets.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const clock = { now: () => 1_000, sleep: () => Promise.resolve() };

export function sampleState(over: Partial<RunState> = {}): RunState {
  return {
    version: 1,
    runId: 'r_20261003_0000_abcd',
    repoRoot: '/r',
    repoName: 'r',
    worktree: '/w',
    branch: 'b',
    startRef: 's',
    lastGreen: 's',
    greenHistory: [],
    phase: 'init',
    status: 'running',
    cycle: 0,
    startedAt: 1,
    updatedAt: 1,
    activeMs: 0,
    goalHash: 'h',
    setupDone: false,
    spend: {
      usd: 0,
      tokens: { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      turns: 0,
      llmCalls: 0,
      byModel: {},
      byProvider: {},
    },
    acceptedCommits: 0,
    beyondRounds: 0,
    rejectedCycles: 0,
    lastProgressCycle: 0,
    warned: [],
    recordedCycle: 0,
    checkpoints: [],
    disabledWorkers: [],
    noChecks: false,
    budgetExhausted: false,
    spendLedger: [],
    dailyCapHit: false,
    cycleTokens: [],
    ...over,
  };
}

describe('atomic writes', () => {
  it('writes, overwrites, reads back; missing files fall back', async () => {
    const dir = await tempDir();
    const f = join(dir, 'sub', 'x.json');
    await writeFileAtomic(f, '{"a":1}');
    await writeFileAtomic(f, '{"a":2}');
    expect(await readJson(f)).toEqual({ a: 2 });
    expect(await readTextOr(join(dir, 'nope'), 'fb')).toBe('fb');
  });
});

describe('EventLog', () => {
  it('redacts, orders, rotates, and survives a torn last line', async () => {
    const dir = await tempDir();
    const path = join(dir, 'events.jsonl');
    const log = new EventLog(path, 'r1', new Redactor(), clock, 200);
    const seen: string[] = [];
    log.onEvent((e) => seen.push(e.type));
    log.cycle = 2;
    log.emit('a', { secret: secretCorpus().anthropic });
    for (let i = 0; i < 5; i++) log.emit('b', { pad: 'x'.repeat(60) });
    expect(seen).toHaveLength(6);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(secretCorpus().anthropic);
    await readFile(`${path}.1`, 'utf8');
    await writeFile(path, `${raw}{"torn":`);
    const events = await readEvents(path);
    expect(events.every((e) => e.runId === 'r1')).toBe(true);
    expect(await readEvents(join(dir, 'none'))).toEqual([]);
  });
});

describe('notes (lessons file)', () => {
  it('add / replace / remove by id, refuses growth past the cap', () => {
    let r = applyRemember(
      [],
      { action: 'add', type: 'env', text: 'tests need DATABASE_URL' },
      100,
      '2026-10-03',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    r = applyRemember(r.notes, { action: 'add', type: 'command', text: 'use pnpm' }, 100, 'd');
    if (!r.ok) throw new Error(r.message);
    expect(r.notes.map((n) => n.id)).toEqual(['N1', 'N2']);
    const rep = applyRemember(
      r.notes,
      { action: 'replace', id: 'N1', text: 'tests need DATABASE_URL=postgres://localhost' },
      100,
      'd',
    );
    expect(rep.ok && rep.notes[0]?.text).toContain('postgres');
    expect(applyRemember(r.notes, { action: 'remove', id: 'N9' }, 100, 'd')).toMatchObject({
      ok: false,
    });
    const full = applyRemember(
      r.notes,
      { action: 'add', type: 'pitfall', text: 'x'.repeat(400) },
      30,
      'd',
    );
    expect(full).toMatchObject({ ok: false, message: expect.stringMatching(/full/) as string });
    const removed = applyRemember(r.notes, { action: 'remove', id: 'N2' }, 1, 'd');
    expect(removed.ok && removed.notes).toHaveLength(1);
    expect(renderNotes([])).toMatch(/no lessons/);
  });
});

describe('RunStore', () => {
  it('state, plan, goal hash, notes, idempotent progress, control, heartbeat', async () => {
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    const id = newRunId(new Date(2026, 9, 3, 18, 34));
    expect(id).toMatch(RUN_ID_RE);
    expect(id.startsWith('r_20261003_1834_')).toBe(true);
    const store = new RunStore(paths, id);
    await store.init();
    await expect(store.readState()).rejects.toThrow(/cannot read state/);
    await store.writeState(sampleState({ runId: id }));
    expect((await store.readState()).runId).toBe(id);
    await writeFile(store.file('state.json'), '{"version":1}');
    await expect(store.readState()).rejects.toThrow(/invalid/);
    expect(await store.readPlan()).toBeUndefined();
    await store.writeGoal('make it work');
    expect((await store.readGoal()).hash).toBe(sha256('make it work\n'));
    expect(await store.readNotes()).toEqual([]);
    await store.writeNotes([{ id: 'N1', type: 'env', text: 't', date: 'd' }]);
    expect(await readFile(store.file('notes.md'), 'utf8')).toContain('[N1] (env, d) t');
    expect(await store.appendProgress(1, 'first')).toBe(true);
    expect(await store.appendProgress(1, 'dup')).toBe(false);
    await store.appendProgress(2, 'second');
    await store.appendProgress(3, 'third');
    expect(await store.progressTail(2)).toBe('## Cycle 2\nsecond\n\n## Cycle 3\nthird');
    expect(await store.progressTail(0)).toBe('');
    expect(await store.readControl()).toBeUndefined();
    await store.writeControl({ request: 'pause', at: 5 });
    expect(await store.readControl()).toEqual({ request: 'pause', at: 5 });
    expect(await store.readHeartbeat()).toBeUndefined();
    await store.writeHeartbeat({
      ts: 1,
      pid: 2,
      phase: 'act',
      status: 'running',
      cycle: 1,
      spentUsd: 0,
      lastGreen: 's',
    });
    expect((await store.readHeartbeat())?.phase).toBe('act');
    expect(await listRunIds(paths)).toEqual([id]);
    expect(await listRunIds(resolvePaths({ OMNEXX_HOME: join(await tempDir(), 'none') }))).toEqual(
      [],
    );
  });
});
