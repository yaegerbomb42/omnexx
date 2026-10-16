import { describe, expect, it } from 'vitest';
import { digest, enforceBudget } from '../../../src/agent/budget-guard.js';
import {
  contextTokens,
  manageContext,
  type CompactionEvent,
  type CompactionSettings,
  type CycleSummary,
  type Summarize,
} from '../../../src/agent/compaction.js';
import { FOLD_FRACTION, contextProfile } from '../../../src/core/agent-levels.js';
import type { Message } from '../../../src/providers/types.js';

const first: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Work on M1.T01: fix add()' }],
};

/** Deterministic PRNG so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function turnAt(i: number, size: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `t${String(i)}`,
          name: 'bash',
          input: { command: `step ${String(i)}` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `t${String(i)}`,
          content: `${String(i)}:${'line\n'.repeat(Math.ceil(size / 5))}`,
        },
      ],
    },
  ];
}

const state = (n: number): CycleSummary => ({
  done: [`fold ${String(n)} step`],
  inProgress: `in progress ${String(n)}`,
  filesTouched: [],
  keyFiles: [`src/f${String(n)}.ts — touched in fold ${String(n)}`],
  nextStep: `next ${String(n)}`,
});

function folder(): { summarize: Summarize; priors: (CycleSummary | undefined)[] } {
  const priors: (CycleSummary | undefined)[] = [];
  let n = 0;
  return {
    priors,
    summarize: (_head, prior) => {
      priors.push(prior);
      return Promise.resolve(state(++n));
    },
  };
}

const settingsFor = (budget: number, keepTurns = 2): CompactionSettings => ({
  budget,
  compactAt: Math.floor(budget * FOLD_FRACTION),
  clearAt: Math.floor(budget * 0.6),
  keepToolResults: 4,
  keepTurns,
});

const firstText = (m: Message[]): string => JSON.stringify(m[0]);

describe('fold into the working state', () => {
  it('folds at 85% of the budget, keeps the last K turns verbatim and the analysis word for word', async () => {
    const budget = 6_000;
    const analysis = 'Framing: add() subtracts.\nApproach: fix the operator.\nVerify: npm test.';
    const msgs = [first, ...Array.from({ length: 8 }, (_, i) => turnAt(i, 2_400)).flat()];
    expect(contextTokens(msgs)).toBeGreaterThan(budget * FOLD_FRACTION);
    const { summarize } = folder();
    const events: CompactionEvent[] = [];
    const out = await manageContext(
      msgs,
      first,
      { ...settingsFor(budget), pinned: analysis, clearAt: 1e9 },
      summarize,
      (e) => events.push(e),
    );
    expect(events.map((e) => e.kind)).toContain('compacted');
    expect(firstText(out)).toContain(JSON.stringify(analysis).slice(1, -1));
    expect(firstText(out)).toContain('fold 1 step');
    // The newest turn is kept exactly; the turn before it may be settled to a digest.
    expect(out.slice(-2)).toEqual(msgs.slice(-2));
    expect(out.at(-4)).toEqual(msgs.at(-4));
    expect(contextTokens(out)).toBeLessThanOrEqual(budget);
  });

  it('does not fold below the threshold', async () => {
    const msgs = [first, ...turnAt(0, 400), ...turnAt(1, 400), ...turnAt(2, 400)];
    const { summarize, priors } = folder();
    const out = await manageContext(msgs, first, settingsFor(100_000), summarize, () => undefined);
    expect(priors).toHaveLength(0);
    expect(out).toEqual(msgs);
  });

  it('merges with the previous working state on the next fold and keeps the analysis', async () => {
    const budget = 6_000;
    const analysis = 'My analysis, verbatim.';
    const { summarize, priors } = folder();
    let msgs = [first, ...Array.from({ length: 8 }, (_, i) => turnAt(i, 2_400)).flat()];
    msgs = await manageContext(
      msgs,
      first,
      { ...settingsFor(budget), pinned: analysis, clearAt: 1e9 },
      summarize,
      () => undefined,
    );
    msgs = [...msgs, ...Array.from({ length: 8 }, (_, i) => turnAt(100 + i, 2_400)).flat()];
    // The second fold runs without `pinned`: the analysis is carried from the first state.
    msgs = await manageContext(
      msgs,
      first,
      { ...settingsFor(budget), clearAt: 1e9 },
      summarize,
      () => undefined,
    );
    expect(priors[0]).toBeUndefined();
    expect(priors[1]?.done).toEqual(['fold 1 step']);
    const text = firstText(msgs);
    expect(text).toContain('fold 1 step');
    expect(text).toContain('fold 2 step');
    expect(text).toContain('src/f1.ts');
    expect(text).toContain('src/f2.ts');
    expect(text).toContain(analysis);
    expect(text).toContain('in progress 2');
    expect(text).not.toContain('in progress 1');
  });

  it('keeps the folded prefix byte-identical between folds (append-only, cache-stable)', async () => {
    const budget = 40_000;
    const { summarize } = folder();
    let msgs = [first, ...Array.from({ length: 12 }, (_, i) => turnAt(i, 12_000)).flat()];
    msgs = await manageContext(
      msgs,
      first,
      { ...settingsFor(budget, 2), clearAt: 1e9 },
      summarize,
      () => undefined,
    );
    const folded = firstText(msgs);
    const kinds: string[] = [];
    const refolded = () => kinds.includes('compacted');
    for (let i = 0; i < 40 && !refolded(); i++) {
      const before = msgs.length;
      msgs = await manageContext(
        [...msgs, ...turnAt(200 + i, 3_000)],
        first,
        { ...settingsFor(budget, 2), clearAt: 1e9 },
        summarize,
        (e) => kinds.push(e.kind),
      );
      if (!refolded()) {
        expect(firstText(msgs)).toBe(folded);
        expect(msgs.length).toBe(before + 2);
      }
    }
    expect(refolded()).toBe(true);
    expect(firstText(msgs)).not.toBe(folded);
  });

  it('never leaves the context over the budget (random tool outputs, failing folder too)', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const budget = [5_000, 10_000, 20_000, 40_000][seed % 4] ?? 5_000;
      const summarize: Summarize = () =>
        seed % 3 === 0 ? Promise.resolve(undefined) : Promise.resolve(state(seed));
      let msgs: Message[] = [first];
      for (let i = 0; i < 30; i++) {
        const size = rand() < 0.2 ? Math.floor(rand() * budget * 6) : Math.floor(rand() * 3_000);
        msgs = await manageContext(
          [...msgs, ...turnAt(i, size)],
          first,
          settingsFor(budget),
          summarize,
          () => undefined,
        );
        expect(contextTokens(msgs)).toBeLessThanOrEqual(budget);
        // Every call keeps its result.
        const uses = msgs.flatMap((m) =>
          m.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])),
        );
        const results = msgs.flatMap((m) =>
          m.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])),
        );
        expect(results).toEqual(uses);
      }
    }
  });
});

describe('budget guard', () => {
  it('digests keep the head, the tail and the way back', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n');
    const d = digest(`[exit 1, 9ms, log cmd-1-2]\n${lines}`);
    expect(d).toContain('read_log id="cmd-1-2"');
    expect(d).toContain('line 0');
    expect(d).toContain('line 99');
    expect(d).not.toContain('line 50');
  });

  it('spares the newest turn when asked and never touches the first message', () => {
    const msgs = [first, ...turnAt(0, 8_000), ...turnAt(1, 8_000)];
    const spared = enforceBudget(msgs, 1_000, true);
    expect(spared.messages.slice(-2)).toEqual(msgs.slice(-2));
    expect(spared.messages[0]).toBe(first);
    const hard = enforceBudget(msgs, 1_000);
    expect(hard.tokens).toBeLessThanOrEqual(1_000);
  });

  it('a 1M level clamps to 85% of the window and folds at 85% of that', () => {
    expect(contextProfile(10, 1_048_576)).toMatchObject({ budget: 891_289, compactAt: 757_595 });
    expect(contextProfile(10, 200_000).budget).toBe(170_000);
    expect(contextProfile(10).budget).toBe(1_000_000);
  });
});
