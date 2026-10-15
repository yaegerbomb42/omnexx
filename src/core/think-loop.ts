import type { LoopEnd, LoopResult } from '../agent/loop.js';
import type { Message } from '../providers/types.js';
import type { Usage } from '../providers/types.js';

/**
 * A think-first loop session: one conversation that solves a task end to end.
 *
 * 1. Think: explore, then write an analysis (framing, root causes and invariants, approach,
 *    ordered steps, how each is verified), with the strongest models.
 * 2. Execute it in the same conversation (the analysis is right there, not re-summarized), then
 *    the harness runs the checks. A failure goes back as the next message: the work is kept and
 *    fixed forward, never rolled back to the start.
 * 3. Stuck (an in-cycle stuck signal, or the same failure twice): re-think in place with the
 *    strong models ("which assumption is wrong?"), then carry on. No fresh worker.
 * 4. Once green, one review of the final diff against the goal and the analysis; a finding is
 *    one more turn here, not a rejection.
 *
 * The tree of the last green check is remembered: a session that ends red goes back to it, so
 * the cycle still commits the last state that passed. On the bench, cost exploded when a failed
 * pass handed off to a planner, fresh workers and per-cycle rollbacks; this keeps the thinking
 * and drops the hand-offs.
 */

export const THINK_PROMPT = `# Think first

Before you change anything, understand the problem. Explore what you need (put independent reads in one turn: they run in parallel), then stop calling tools and write your analysis:
1. Framing: what the problem really is, in your own words.
2. Root causes and key invariants, and how the requirements interact (where one constrains another).
3. The approach, and why it is right.
4. Ordered steps.
5. How you will verify each step (which tests or commands).
Do not edit files in this phase. The analysis stays in this conversation while you carry it out.`;

export const EXECUTE_PROMPT =
  '[harness] Now carry out your analysis step by step, in this conversation. Keep a todo list. Run the relevant tests after each meaningful change and fix what fails. When everything is done and verified, stop calling tools and summarize what you changed.';

export const EXECUTE_REVISED_PROMPT =
  '[harness] Now carry out the revised analysis. Run the relevant tests as you go; when everything is done and verified, stop calling tools and summarize.';

export const fixPrompt = (failures: string): string =>
  `[harness] The project's checks fail on the current tree. Your work is kept (nothing was rolled back); fix forward:\n\n${failures}\n\nWhen they pass, stop calling tools and summarize.`;

export const rethinkPrompt = (why: string): string =>
  `[harness] You are stuck: ${why}. Stop and re-think before changing anything else. Which assumption in your analysis is wrong? Re-read the failing output and the code it points to, then write a revised analysis: framing, root cause, approach, steps, verification. Do not edit files in this step.`;

export const reviewPrompt = (findings: string): string =>
  `[harness] A review of your final diff against the goal and your analysis found:\n\n${findings}\n\nFix these, re-run the relevant tests, then stop calling tools and summarize.`;

export type ChainKind = 'think' | 'work';

/** One stretch of the conversation, run by the agent loop on one model chain. */
export interface Segment {
  history: readonly Message[];
  first: Message;
  anchor: Message;
}

export interface CheckOutcome {
  pass: boolean;
  /** What failed, for the next message (empty when it passed). */
  failures: string;
  /** Normalized failure text: the same signature twice means no progress. */
  signature: string;
  /** Git tree of the checked working tree. */
  tree: string;
}

export interface SessionIO {
  segment: (s: Segment, chain: ChainKind) => Promise<LoopResult>;
  check: () => Promise<CheckOutcome>;
  /** Blocking findings of the end review, rendered; undefined when there are none (or it is off). */
  review?: (analysis: string) => Promise<string | undefined>;
  /** Put the working tree back to a tree a check passed on. */
  restore: (tree: string) => Promise<void>;
  emit: (type: string, data: Record<string, unknown>) => void;
}

export interface SessionLimits {
  rounds: number;
  rethinks: number;
}

export interface SessionResult extends LoopResult {
  analysis: string;
  reviewed: boolean;
  rounds: number;
  rethinks: number;
  /** Whether the tree the session left passed its last check. */
  green: boolean;
}

/** Ends after which nothing more may run in this session (stop requests, money, providers). */
const TERMINAL: ReadonlySet<LoopEnd> = new Set<LoopEnd>([
  'stop',
  'stop-now',
  'max_usd',
  'max_usd_per_day',
  'providers_unavailable',
  'refusal',
]);

const textMessage = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const zeroUsage = (): Usage => ({
  uncached: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});

function addUsage(a: Usage, b: Usage): Usage {
  return {
    uncached: a.uncached + b.uncached,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

/**
 * The next segment's history and opening message. A segment cut short after tool results ends on
 * a user message; the harness's text joins it so roles keep alternating.
 */
export function continueWith(
  history: readonly Message[],
  text: string,
): { history: Message[]; first: Message } {
  const last = history.at(-1);
  if (last?.role === 'user')
    return {
      history: history.slice(0, -1),
      first: { role: 'user', content: [...last.content, { type: 'text', text }] },
    };
  return { history: [...history], first: textMessage(text) };
}

interface Step {
  text: string;
  chain: ChainKind;
  /** A think step's final text replaces the analysis. */
  thinking: boolean;
}

/** Run one task as a think-first loop session. `first` is the task's opening context. */
export async function runThinkLoop(
  first: Message,
  io: SessionIO,
  limits: SessionLimits,
): Promise<SessionResult> {
  const anchor: Message = {
    role: 'user',
    content: [...first.content, { type: 'text', text: THINK_PROMPT }],
  };
  let messages: Message[] = [];
  let usage = zeroUsage();
  let usd = 0;
  let turns = 0;
  let finalText = '';
  let analysis = '';
  let last: LoopResult | undefined;
  let green: string | undefined;
  let greenNow = false;
  let reviewed = false;
  let rounds = 0;
  let rethinks = 0;
  let lastSignature = '';

  const run = async (step: Step | undefined): Promise<LoopResult> => {
    const seg = step ? continueWith(messages, step.text) : { history: [], first: anchor };
    const r = await io.segment({ ...seg, anchor }, step?.chain ?? 'think');
    messages = r.messages;
    usage = addUsage(usage, r.usage);
    usd += r.usd;
    turns += r.turns;
    if (r.finalText) finalText = r.finalText;
    if (r.turns > 0) greenNow = false;
    if (!step || step.thinking) analysis = r.finalText || analysis;
    last = r;
    return r;
  };

  const finish = async (end: LoopEnd): Promise<SessionResult> => {
    // Ended red after a green check: leave the last tree that passed for the cycle to commit.
    if (!greenNow && green) {
      await io.restore(green);
      io.emit('loop.restore_green', { tree: green });
      greenNow = true;
    }
    io.emit('loop.end', { end, rounds, rethinks, reviewed, green: greenNow, turns });
    return {
      end,
      turns,
      finalText,
      usage,
      usd,
      messages,
      ...(last?.stuck && end === 'stuck' ? { stuck: last.stuck } : {}),
      analysis,
      reviewed,
      rounds,
      rethinks,
      green: greenNow,
    };
  };

  const thought = await run(undefined);
  io.emit('loop.think', { turns: thought.turns, chars: analysis.length, end: thought.end });
  if (TERMINAL.has(thought.end)) return finish(thought.end);

  let next: Step = { text: EXECUTE_PROMPT, chain: 'work', thinking: false };
  const rethink = (why: string): Step | undefined => {
    if (rethinks >= limits.rethinks) return undefined;
    rethinks++;
    io.emit('loop.rethink', { why: why.slice(0, 300), rethink: rethinks });
    return { text: rethinkPrompt(why), chain: 'think', thinking: true };
  };

  while (rounds < limits.rounds) {
    const r = await run(next);
    if (TERMINAL.has(r.end)) return finish(r.end);
    if (next.thinking) {
      next = { text: EXECUTE_REVISED_PROMPT, chain: 'work', thinking: false };
      continue;
    }
    rounds++;
    if (r.end === 'stuck') {
      const step = rethink(r.stuck?.detail ?? 'no progress');
      if (step) {
        next = step;
        continue;
      }
    }
    const c = await io.check();
    io.emit('loop.check', { round: rounds, pass: c.pass, failures: c.failures.slice(0, 300) });
    if (c.pass) {
      green = c.tree;
      greenNow = true;
      lastSignature = '';
      if (reviewed || !io.review) return finish('done');
      reviewed = true;
      const findings = await io.review(analysis);
      io.emit('loop.review', { blocking: Boolean(findings) });
      if (!findings) return finish('done');
      next = { text: reviewPrompt(findings), chain: 'work', thinking: false };
      continue;
    }
    const same = c.signature !== '' && c.signature === lastSignature;
    lastSignature = c.signature;
    const step = same
      ? rethink(`the same checks still fail the same way:\n${c.failures}`)
      : undefined;
    next = step ?? { text: fixPrompt(c.failures), chain: 'work', thinking: false };
  }
  io.emit('loop.rounds_spent', { rounds });
  return finish(last?.end === 'stuck' ? 'stuck' : 'done');
}
