import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  condense,
  condenseRolling,
  emptyNote,
  parseRollingNote,
  renderRollingNote,
  shouldCondense,
  ROLLING_NOTE_CHAR_CAP,
  type RollingNote,
} from '../../../src/agent/rolling-memory.js';
import type { Message } from '../../../src/providers/types.js';

const first: Message = { role: 'user', content: [{ type: 'text', text: 'Work on M1.T01' }] };

/** One assistant turn: text + one tool call, then its tool result. */
function turn(
  n: number,
  opts: {
    text?: string;
    tool?: string;
    input?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  } = {},
): Message[] {
  const tool = opts.tool ?? 'bash';
  const input = opts.input ?? { command: `step ${n}` };
  return [
    {
      role: 'assistant',
      content: [
        ...(opts.text ? [{ type: 'text', text: opts.text } as const] : []),
        { type: 'tool_use', id: `t${n}`, name: tool, input },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `t${n}`,
          content: opts.result ?? `ok ${n}`,
          ...(opts.isError ? { isError: true } : {}),
        },
      ],
    },
  ];
}

/** A conversation of `n` turns, each editing a file for feature `n`. */
function convo(n: number): Message[] {
  const out: Message[] = [first];
  for (let i = 1; i <= n; i++) {
    out.push(
      ...turn(i, {
        text: `feature ${i}: add the widget\nDecided to use the existing helper instead of a new one.`,
        tool: 'str_replace',
        input: { path: `src/feature${i}.ts`, old_str: 'a', new_str: 'b' },
        result: `edited src/feature${i}.ts`,
      }),
    );
  }
  return out;
}

const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

describe('rolling memory note', () => {
  it('renders all six sections and round-trips through parse', () => {
    const note: RollingNote = {
      goal: 'M1.T01: add the widget',
      active: [
        {
          title: 'feature 9: add the widget',
          detail: ['edited src/feature9.ts', 'ran `npm test`'],
          turn: 9,
        },
      ],
      decisions: ['use the existing helper instead of a new one'],
      facts: [{ path: 'src/feature9.ts', hash: 'abc123def456' }],
      threads: [{ line: 'feature 3: add the widget', turn: 3 }],
      failed: ['turn 4: bash — npm test failed: 2 tests'],
      coversFrom: 1,
      coversTo: 9,
      updatedTurn: 11,
    };
    const rendered = renderRollingNote(note);
    for (const h of [
      '# Memory (rolling)',
      '## Current goal',
      '## Active work (newest first)',
      '## Decisions and why',
      '## Facts',
      '## Open threads (older work, one line each)',
      "## Failed attempts (don't retry)",
    ])
      expect(rendered).toContain(h);
    expect(rendered).toContain('src/feature9.ts — sha256:abc123def456');
    expect(rendered).toContain('feature 3: add the widget — turn 3 (8 turns ago)');
    const back = parseRollingNote(rendered);
    expect(back).toMatchObject({
      goal: 'M1.T01: add the widget',
      decisions: ['use the existing helper instead of a new one'],
      facts: [{ path: 'src/feature9.ts', hash: 'abc123def456' }],
      failed: ['turn 4: bash — npm test failed: 2 tests'],
      coversFrom: 1,
      coversTo: 9,
      updatedTurn: 11,
    });
    expect(back?.active[0]).toMatchObject({
      title: 'feature 9: add the widget',
      turn: 9,
      detail: ['edited src/feature9.ts', 'ran `npm test`'],
    });
    expect(back?.threads).toEqual([{ line: 'feature 3: add the widget', turn: 3 }]);
  });

  it('condenses turns: newest work detailed, decisions and failures kept, facts hashed', async () => {
    const head = convo(5).slice(1);
    const note = await condense(head, undefined, {
      goal: 'M1.T01: add the widget',
      turn: 7,
      headLastTurn: 5,
      readFile: (p) => Promise.resolve(`content of ${p}`),
    });
    expect(note.goal).toBe('M1.T01: add the widget');
    expect(note.coversFrom).toBe(1);
    expect(note.coversTo).toBe(5);
    expect(note.updatedTurn).toBe(7);
    // Newest first, full detail.
    expect(note.active[0]?.turn).toBe(5);
    expect(note.active[0]?.detail).toContain('edited src/feature5.ts');
    expect(note.active.length).toBeLessThanOrEqual(3);
    // Decisions pulled from the assistant text.
    expect(note.decisions).toContain('Decided to use the existing helper instead of a new one.');
    // Facts carry the hash of the file's current contents.
    expect(note.facts).toContainEqual({
      path: 'src/feature5.ts',
      hash: sha12('content of src/feature5.ts'),
    });
    // Older work shrinks to one-line threads.
    expect(note.threads.map((t) => t.turn)).toEqual([2, 1]);
    expect(note.threads[0]?.line).toBe('feature 2: add the widget');
  });

  it('records failed attempts so they are not retried', async () => {
    const messages: Message[] = [
      first,
      ...turn(1, { text: 'try the new API', result: 'boom', isError: true }),
      ...turn(2, { text: 'fall back to the old API' }),
    ];
    const note = await condense(messages.slice(1), undefined, {
      goal: 'g',
      turn: 4,
      headLastTurn: 2,
    });
    expect(note.failed).toHaveLength(1);
    expect(note.failed[0]).toContain('turn 1: bash — boom');
    expect(renderRollingNote(note)).toContain("## Failed attempts (don't retry)");
  });

  it('nothing is dropped silently across repeated condensations', async () => {
    // 21 turns, condensed every 7 like the loop does; every turn is one feature.
    let messages = convo(7);
    const persisted: string[] = [];
    const step = async (turnNo: number) => {
      const r = await condenseRolling(messages, messages[0] as Message, {
        turn: turnNo,
        goal: 'M1: ship 21 features',
        keepTurns: 2,
        readFile: (p) => Promise.resolve(`content of ${p}`),
        persistTranscript: (t) => {
          persisted.push(t);
          return Promise.resolve();
        },
      });
      expect(r).toBeDefined();
      messages = r?.messages ?? messages;
    };
    await step(7);
    // Turns 8–14 on top of the condensed conversation.
    for (let i = 8; i <= 14; i++)
      messages.push(
        ...turn(i, {
          text: `feature ${i}: add the widget`,
          tool: 'str_replace',
          input: { path: `src/feature${i}.ts`, old_str: 'a', new_str: 'b' },
        }),
      );
    await step(14);
    for (let i = 15; i <= 21; i++)
      messages.push(
        ...turn(i, {
          text: `feature ${i}: add the widget`,
          tool: 'str_replace',
          input: { path: `src/feature${i}.ts`, old_str: 'a', new_str: 'b' },
        }),
      );
    await step(21);

    const rendered = (messages[0]?.content[1] as { text: string }).text;
    const note = parseRollingNote(rendered);
    expect(note?.coversFrom).toBe(1);
    expect(note?.coversTo).toBe(19);
    // Every feature appears exactly once: detailed in Active work or one line in Open threads.
    const seen = [
      ...(note?.active.map((w) => w.title) ?? []),
      ...(note?.threads.map((t) => t.line) ?? []),
    ];
    expect(seen).toHaveLength(19);
    for (let i = 1; i <= 19; i++) expect(seen).toContain(`feature ${i}: add the widget`);
    // Recency weighting: the newest feature is detailed, the oldest is a one-liner.
    expect(note?.active[0]?.turn).toBe(19);
    expect(note?.active[0]?.detail).toContain('edited src/feature19.ts');
    expect(note?.threads.at(-1)).toEqual({ line: 'feature 1: add the widget', turn: 1 });
    // The folded transcript went to disk, turn by turn.
    expect(persisted).toHaveLength(3);
    expect(persisted[0]).toContain('## Turns 1–5 (condensed at turn 7)');
    expect(persisted[0]).toContain('feature 1: add the widget');
    expect(persisted[2]).toContain('## Turns 13–19 (condensed at turn 21)');
  });

  it('condenseRolling keeps the last turns raw and is undefined when too few are old', async () => {
    const messages = convo(7);
    const r = await condenseRolling(messages, messages[0] as Message, {
      turn: 7,
      goal: 'g',
      keepTurns: 2,
    });
    expect(r).toBeDefined();
    // Anchor + note, then the last 2 turns raw (2 messages each).
    expect(r?.messages).toHaveLength(1 + 4);
    expect(r?.messages[0]?.content).toHaveLength(2);
    expect(r?.turnsSummarized).toBe(5);
    const tailAssistants = (r?.messages.slice(1) ?? []).filter((m) => m.role === 'assistant');
    expect(tailAssistants).toHaveLength(2);

    const short = convo(2);
    await expect(
      condenseRolling(short, short[0] as Message, { turn: 2, goal: 'g', keepTurns: 2 }),
    ).resolves.toBeUndefined();
  });

  it('file hashes refresh when a file changes between condensations', async () => {
    const contents = new Map([['src/a.ts', 'v1']]);
    const head1 = [
      ...turn(1, {
        text: 'write a',
        tool: 'str_replace',
        input: { path: 'src/a.ts', old_str: 'x', new_str: 'y' },
      }),
    ];
    const n1 = await condense(head1, undefined, {
      goal: 'g',
      turn: 3,
      headLastTurn: 1,
      readFile: (p) => Promise.resolve(contents.get(p)),
    });
    expect(n1.facts).toContainEqual({ path: 'src/a.ts', hash: sha12('v1') });
    contents.set('src/a.ts', 'v2');
    const head2 = [
      ...turn(2, {
        text: 'rewrite a',
        tool: 'str_replace',
        input: { path: 'src/a.ts', old_str: 'y', new_str: 'z' },
      }),
    ];
    const n2 = await condense(head2, n1, {
      goal: 'g',
      turn: 5,
      headLastTurn: 2,
      readFile: (p) => Promise.resolve(contents.get(p)),
    });
    expect(n2.facts).toContainEqual({ path: 'src/a.ts', hash: sha12('v2') });
    expect(n2.facts.filter((f) => f.path === 'src/a.ts')).toHaveLength(1);
  });

  it('stays within its char cap and says what it collapsed', () => {
    const note: RollingNote = {
      ...emptyNote('g', 100),
      coversFrom: 1,
      coversTo: 95,
      active: [{ title: 'newest', detail: ['edited src/new.ts'], turn: 95 }],
      threads: Array.from({ length: 60 }, (_, i) => ({
        line: `old feature ${i} with a fairly long title describing the work`,
        turn: i + 1,
      })),
      decisions: Array.from({ length: 15 }, (_, i) => `decision ${i}`),
      failed: Array.from({ length: 15 }, (_, i) => `turn ${i}: something failed badly`),
    };
    const rendered = renderRollingNote(note);
    expect(rendered.length).toBeLessThanOrEqual(ROLLING_NOTE_CHAR_CAP);
    expect(rendered).toContain('older thread');
    const back = parseRollingNote(rendered);
    expect(back?.collapsed?.count).toBeGreaterThan(0);
    expect(back?.active[0]?.title).toBe('newest');
  });

  it('folds on the 6–8 turn cadence', () => {
    expect(shouldCondense(6, 0, 7)).toBe(false);
    expect(shouldCondense(7, 0, 7)).toBe(true);
    expect(shouldCondense(13, 7, 7)).toBe(false);
    expect(shouldCondense(14, 7, 7)).toBe(true);
    expect(shouldCondense(8, 0, 8)).toBe(true);
  });
});
