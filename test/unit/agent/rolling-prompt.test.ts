import { describe, expect, it } from 'vitest';
import { turnRequest } from '../../../src/agent/context.js';
import { condenseRolling, ROLLING_NOTE_CHAR_CAP } from '../../../src/agent/rolling-memory.js';
import { estimateTokens } from '../../../src/core/tokens.js';
import type { Message, SystemBlock, ToolSpec } from '../../../src/providers/types.js';

/**
 * A long simulated task: 40 turns, each reading ~3k chars of tool output. With rolling memory
 * (condense every 7 turns, keep the last 2 raw) the prompt the model sees should stay roughly
 * flat — a sawtooth between condensations, not a staircase. Without it, the same task grows
 * linearly. The numbers print below the test run; quote them in the report.
 */

const TURNS = 40;
const EVERY = 7;
const KEEP = 2;

const system: SystemBlock[] = [
  { text: 'You are a coding agent. Work on the task, calling tools, until it is done.' },
  { text: 'Repo: a TypeScript CLI. Tests: npm run test:quick. Never invent file contents.' },
];
const tools: ToolSpec[] = [
  {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'bash',
    description: 'Run a command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
  {
    name: 'str_replace',
    description: 'Edit a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const first: Message = { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] };
const filler = (n: number, seed: string): string =>
  `${seed} ${'x'.repeat(Math.max(0, n - seed.length - 1))}`;

/** One turn's messages: an assistant read + a ~3k-char result, like a real working turn. */
function turnMessages(i: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Turn ${i}: checking feature ${i} against the spec.` },
        {
          type: 'tool_use',
          id: `t${i}`,
          name: 'read',
          input: { path: `src/feature${i}.ts` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `t${i}`,
          content: filler(3_000, `// src/feature${i}.ts`),
        },
      ],
    },
  ];
}

const promptTokens = (messages: readonly Message[]): number =>
  estimateTokens(JSON.stringify(turnRequest({ system, tools }, [...messages], 'model', 4096)));

const mean = (xs: readonly number[]): number =>
  xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('rolling memory prompt size', () => {
  it('stays flat over a long task while the raw history grows linearly', async () => {
    const rolling: number[] = [];
    const baseline: number[] = [];
    let messages: Message[] = [first];
    const raw: Message[] = [first];
    let lastNote = '';
    for (let i = 1; i <= TURNS; i++) {
      const t = turnMessages(i);
      messages.push(...t);
      raw.push(...t);
      if (i % EVERY === 0) {
        const r = await condenseRolling(messages, messages[0] as Message, {
          turn: i,
          goal: 'M1.T01: ship 40 features',
          keepTurns: KEEP,
        });
        expect(r).toBeDefined();
        messages = r?.messages ?? messages;
        lastNote = r?.note ?? '';
      }
      rolling.push(promptTokens(messages));
      baseline.push(promptTokens(raw));
    }

    // The numbers, for the report.
    console.log('turn | rolling tokens | raw-history tokens');
    for (let i = 0; i < TURNS; i += 4)
      console.log(
        `${String(i + 1).padStart(4)} | ${String(rolling[i]).padStart(14)} | ${String(baseline[i]).padStart(18)}`,
      );
    const mid = mean(rolling.slice(9, 19));
    const late = mean(rolling.slice(-10));
    const maxLate = Math.max(...rolling.slice(14));
    console.log(
      `rolling: mean turns 10–19=${Math.round(mid)}, mean turns 31–40=${Math.round(late)} (${(((late - mid) / mid) * 100).toFixed(1)}%), max turns 15–40=${maxLate}, baseline turn 40=${baseline[39]} vs turn 10=${baseline[9]}`,
    );

    expect(lastNote.length).toBeLessThanOrEqual(ROLLING_NOTE_CHAR_CAP);
    // Flat: the last ten turns cost about the same as the middle ten, and the sawtooth peak
    // stays well under twice the mid-run mean.
    expect(Math.abs(late - mid) / mid).toBeLessThan(0.25);
    expect(maxLate).toBeLessThan(1.75 * mid);
    // And the measurement itself catches growth: raw history at turn 40 is far past turn 10.
    expect(baseline[39] as number).toBeGreaterThan(3 * (baseline[9] as number));
    expect(baseline[39] as number).toBeGreaterThan(3 * (rolling[39] as number));
  });
});
