import { describe, expect, it } from 'vitest';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { ProviderRouter } from '../../src/providers/router.js';
import type { CompletionRequest, Provider } from '../../src/providers/types.js';
import { startTestRun } from '../support/harness.js';
import { call, say, ScriptedProvider } from '../support/scripted-provider.js';

const plan = {
  milestones: [
    {
      id: 'M1',
      title: 'Fix',
      tasks: [{ id: 'M1.T01', title: 'Make add() add', checks: ['node --test'] }],
    },
  ],
};

const summary = {
  done: ['listed numbers several times'],
  inProgress: 'about to fix add()',
  filesTouched: [],
  nextStep: 'replace a - b with a + b in src/math.js',
};

describe('in-cycle compaction', () => {
  it('clears and compacts a long cycle via the routed cheap chain, then still lands the fix', async () => {
    let workerTurns = 0;
    const worker = new ScriptedProvider(() => {
      workerTurns++;
      if (workerTurns <= 6)
        return call('bash', {
          command: `printf '%0400d\\n' ${workerTurns} 1 2 3 4 5 6 7 8 9`,
        });
      if (workerTurns === 7)
        return call('str_replace', {
          path: 'src/math.js',
          old_str: 'return a - b;',
          new_str: 'return a + b;',
        });
      return say('Fixed add().');
    });
    const summarizer = new ScriptedProvider(() => call('answer', summary));
    const routes: (string | undefined)[] = [];
    const tap = (p: Provider): Provider => ({
      name: p.name,
      complete: (req: CompletionRequest) => {
        routes.push(req.route);
        return p.complete(req);
      },
    });
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: tap(
        new ProviderRouter({
          providers: new Map<string, Provider>([
            ['anthropic', worker],
            ['side', summarizer],
          ]),
        }),
      ),
      plan,
      config: {
        providers: { endpoints: { side: { base_url: 'http://127.0.0.1:9/v1', free: true } } },
        models: { cheap: 'side:tiny' },
        context: {
          // This test is about the cheap-chain fold, which lives under memory: full;
          // the rolling default condenses deterministically instead (see rolling-memory).
          memory: 'full',
          clear_tool_results_at: 2_000,
          keep_tool_results: 2,
          compact_at: 2_500,
          compact_keep_turns: 2,
        },
      },
    });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept', done: true });

    const events = await readEvents(t.run.store.eventsPath);
    expect(events.some((e) => e.type === 'context.cleared')).toBe(true);
    const compacted = events.filter((e) => e.type === 'context.compacted');
    expect(compacted.length).toBeGreaterThan(0);
    for (const c of compacted)
      expect(c.tokensAfter as number).toBeLessThan(c.tokensBefore as number);

    // The summary went to the cheap endpoint, never to the worker's provider.
    expect(summarizer.requests.length).toBe(compacted.length);
    expect(routes).toContain('side');
    expect(worker.requests.every((r) => r.toolChoice === undefined)).toBe(true);
    const last = worker.requests.at(-1);
    expect(JSON.stringify(last?.messages[0])).toContain('replace a - b with a + b');
    expect(last?.messages[1]?.role).toBe('assistant');
  });

  it('condenses a long cycle into the rolling note by default, then still lands the fix', async () => {
    let workerTurns = 0;
    const worker = new ScriptedProvider(() => {
      workerTurns++;
      if (workerTurns <= 6)
        return call('bash', {
          command: `printf '%0400d\\n' ${workerTurns} 1 2 3 4 5 6 7 8 9`,
        });
      if (workerTurns === 7)
        return call('str_replace', {
          path: 'src/math.js',
          old_str: 'return a - b;',
          new_str: 'return a + b;',
        });
      return say('Fixed add().');
    });
    const t = await startTestRun({
      fixture: 'ts-failing-test',
      provider: worker,
      plan,
      // No memory setting: rolling is the default.
      config: { context: { clear_tool_results_at: 2_000, keep_tool_results: 2 } },
    });
    await runBaseline(t.run);
    expect(await runOneCycle(t.run, 'M1.T01')).toMatchObject({ verdict: 'accept', done: true });

    const events = await readEvents(t.run.store.eventsPath);
    const condensed = events.filter((e) => e.type === 'context.condensed');
    expect(condensed.length).toBeGreaterThan(0);
    expect(condensed[0]?.turnsSummarized).toBe(5);
    // No model fold ran: the note is deterministic, the cheap chain was never called.
    expect(events.some((e) => e.type === 'context.compacted')).toBe(false);

    const { readFile } = await import('node:fs/promises');
    const note = await readFile(t.run.store.file('memory.md'), 'utf8');
    expect(note).toContain('# Memory (rolling)');
    expect(note).toContain('## Current goal\nM1.T01: Make add() add');
    // Turns 1–5 were bash probes; the edit itself (turn 7) stayed in the raw tail.
    expect(note).toContain('ran `printf');
    const transcript = await readFile(`${t.run.store.logsDir}/transcript.md`, 'utf8');
    expect(transcript).toContain('## Turns 1–5 (condensed at turn 7)');
  });
});
