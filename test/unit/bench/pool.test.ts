import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, readlink, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedSetup, createMutex, planJobs, runPool, tagLines } from '../../../bench/pool.ts';
import { startMeter, type Meter } from '../../../bench/meter.ts';
import { createResultsWriter, resultsDir } from '../../../bench/results.ts';
import type { TaskDef, TaskRunResult } from '../../../bench/types.ts';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const task = (id: string): TaskDef => ({ id, path: id, description: id });

describe('runPool', () => {
  it('never has more than `concurrency` calls in flight and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await runPool([5, 1, 4, 2, 3, 1, 2], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(n * 3);
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(out).toEqual([50, 10, 40, 20, 30, 10, 20]);
  });

  it('runs one at a time with concurrency 1', async () => {
    const order: string[] = [];
    await runPool(['a', 'b', 'c'], 1, async (s) => {
      order.push(`start ${s}`);
      await tick(1);
      order.push(`end ${s}`);
    });
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('handles an empty list and rejects a bad concurrency', async () => {
    expect(await runPool([], 4, () => Promise.resolve(1))).toEqual([]);
    await expect(runPool([1], 0, () => Promise.resolve(1))).rejects.toThrow(/positive integer/);
    await expect(runPool([1], 1.5, () => Promise.resolve(1))).rejects.toThrow(/positive integer/);
  });
});

describe('planJobs', () => {
  it('makes every task × agent × rep, rep-major, tagged task/agent/rN', () => {
    const jobs = planJobs([task('t1'), task('t2')], ['omnexx', 'cline'], 2);
    expect(jobs.map((j) => j.tag)).toEqual([
      't1/omnexx/r1',
      't1/cline/r1',
      't2/omnexx/r1',
      't2/cline/r1',
      't1/omnexx/r2',
      't1/cline/r2',
      't2/omnexx/r2',
      't2/cline/r2',
    ]);
    expect(jobs[4]).toMatchObject({ agent: 'omnexx', rep: 2, task: { id: 't1' } });
  });

  it('rejects reps below one', () => {
    expect(() => planJobs([task('t')], ['a'], 0)).toThrow(/positive integer/);
  });
});

describe('createMutex', () => {
  it('runs sections one at a time in call order, even after one fails', async () => {
    const serial = createMutex();
    const log: string[] = [];
    const section = (name: string, ms: number, fail = false) =>
      serial(async () => {
        log.push(`in ${name}`);
        await tick(ms);
        log.push(`out ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([
      section('a', 10),
      section('b', 1, true),
      section('c', 1),
    ]);
    expect(log).toEqual(['in a', 'out a', 'in b', 'out b', 'in c', 'out c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('tagLines', () => {
  it('prefixes every line', () => {
    expect(tagLines('t1/cline/r2', 'PASS\nmore')).toBe('[t1/cline/r2] PASS\n[t1/cline/r2] more');
  });
});

describe('cachedSetup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('sets each task up once, even for concurrent callers, and copies it per run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-pool-'));
    dirs.push(root);
    const setupTask = vi.fn(async (_t: TaskDef, dir: string) => {
      await tick(5);
      await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'tool.js'), 'x');
      await symlink('../tool.js', join(dir, 'node_modules', '.bin', 'tool'));
      await writeFile(join(dir, 'file.txt'), 'template');
    });
    const setup = cachedSetup({ setupTask }, join(root, 'templates'));
    const runs = ['a', 'b', 'c'].map((n) => join(root, 'work', n));
    await Promise.all(runs.map((w) => setup(task('t1'), w)));
    expect(setupTask).toHaveBeenCalledTimes(1);
    for (const w of runs) {
      expect(await readFile(join(w, 'file.txt'), 'utf-8')).toBe('template');
      // The link stays relative, so it resolves inside the copy rather than the template.
      expect(await readlink(join(w, 'node_modules', '.bin', 'tool'))).toBe('../tool.js');
    }
    // Runs don't share files: one run's edits leave the others alone.
    await writeFile(join(runs[0] ?? '', 'file.txt'), 'edited');
    expect(await readFile(join(runs[1] ?? '', 'file.txt'), 'utf-8')).toBe('template');
  });

  it('fails every run of a task whose setup failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-pool-'));
    dirs.push(root);
    const setup = cachedSetup(
      { setupTask: () => Promise.reject(new Error('setup.sh exited 1')) },
      join(root, 'templates'),
    );
    await expect(setup(task('t1'), join(root, 'w1'))).rejects.toThrow(/setup.sh/);
    await expect(setup(task('t1'), join(root, 'w2'))).rejects.toThrow(/setup.sh/);
  });
});

describe('meter attribution under concurrency', () => {
  const meters: Meter[] = [];
  const cleanups: (() => void)[] = [];
  afterEach(async () => {
    await Promise.all(meters.splice(0).map((m) => m.close()));
    for (const c of cleanups.splice(0)) c();
  });

  it('gives each run its own totals and tags its calls in the shared log', async () => {
    // Upstream answers slowly, with the prompt size the caller asked for as the usage.
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const n = (JSON.parse(body) as { n: number }).n;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ usage: { prompt_tokens: n, completion_tokens: 1 } }));
        }, 5);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    cleanups.push(() => upstream.close());
    const dir = await mkdtemp(join(tmpdir(), 'bench-meter-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const log = join(dir, 'calls.jsonl');
    const ep = {
      baseUrl: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/v1`,
      model: 'M',
      apiKey: 'k',
    };
    const a = await startMeter(ep, log, 't1/omnexx/r1');
    const b = await startMeter(ep, log, 't1/cline/r1');
    meters.push(a, b);
    expect(a.url).not.toBe(b.url);

    const call = (m: Meter, n: number) =>
      fetch(`${m.url}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ n, messages: [] }),
      }).then((r) => r.json());
    // Interleaved calls from both runs at once.
    await Promise.all([call(a, 100), call(b, 7), call(a, 100), call(b, 7), call(b, 7)]);

    expect(a.totals()).toMatchObject({ requests: 2, prompt: 200 });
    expect(b.totals()).toMatchObject({ requests: 3, prompt: 21 });
    // The log line is appended just after the response ends.
    await vi.waitFor(async () => {
      const lines = (await readFile(log, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(5);
    });
    const lines = (await readFile(log, 'utf-8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { tag: string; usage: { prompt_tokens: number } });
    for (const l of lines) expect(l.usage.prompt_tokens).toBe(l.tag === 't1/omnexx/r1' ? 100 : 7);
    expect(lines.filter((l) => l.tag === 't1/cline/r1')).toHaveLength(3);
  });
});

describe('ResultsWriter under concurrency', () => {
  const out = `omnexx-bench-pool-test-${String(Date.now())}`;
  afterEach(() => {
    if (existsSync(resultsDir(out))) rmSync(resultsDir(out), { recursive: true, force: true });
  });

  it('keeps every result and the markdown complete when writes land at once', async () => {
    const writer = createResultsWriter({ suite: 'jimmy10', agents: ['a', 'b'], out });
    const result = (agent: string, rep: number): TaskRunResult => ({
      taskId: 't1',
      suite: 'jimmy10',
      agent,
      rep,
      metrics: {
        resolved: true,
        usd: 0,
        tokens_in: 1,
        tokens_out: 1,
        cached: 0,
        wall_ms: 1,
        interventions: 0,
      },
      startedAt: '',
      finishedAt: '',
    });
    const all = ['a', 'b'].flatMap((agent) => [1, 2, 3].map((rep) => result(agent, rep)));
    await Promise.all(all.map((r) => writer.writeResult(r)));
    const base = join(writer.getOutDir(), writer.getRunId());
    const jsonl = (await readFile(`${base}.jsonl`, 'utf-8')).trim().split('\n');
    expect(jsonl).toHaveLength(6);
    const md = await readFile(`${base}.md`, 'utf-8');
    expect(md).toContain('| Task | Rep | Agent |');
    expect(md.match(/^\| t1 \| \d \| [ab] \|/gm)).toHaveLength(6);
  });
});
