import type { LoopEnd, LoopResult } from '../agent/loop.js';
import type { Message } from '../providers/types.js';
import type { Usage } from '../providers/types.js';
import { analysisSteps, stepsTodo, wroteTodo } from './analysis-steps.js';
import { checkTrip, failKey, tombstone, type PassState, type StateNode } from './doom-breaker.js';

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
 *    A doom loop (checks worse twice in a row, or a failure set coming back) rewinds first: the
 *    tree goes back to the best pass so far and the turns since become a short tombstone.
 * 4. Once green, one review of the final diff against the goal and the analysis; a finding is
 *    one more turn here, not a rejection.
 *
 * The tree of the last green check is remembered: a session that ends red goes back to it, so
 * the cycle still commits the last state that passed. On the bench, cost exploded when a failed
 * pass handed off to a planner, fresh workers and per-cycle rollbacks; this keeps the thinking
 * and drops the hand-offs.
 */

export const THINK_PROMPT = `# Think first

Before you change anything, understand the problem. Read what you need in a few turns: put every independent read in one turn (they run in parallel), starting with the files the goal names and what they use. Don't run experiments or write scratch scripts yet. Then stop calling tools and write your analysis:
1. Framing: what the problem really is, in your own words.
2. Root causes and key invariants, and how the requirements interact (where one constrains another).
3. The approach, and why it is right.
4. Ordered steps.
5. How you will verify each step (which tests or commands).
6. Spec cases: for every rule and example in the goal and the docs it points to (README, issue), one concrete input → expected output, worked out from the spec text, not from the code. Include the cases where two rules meet (ordering, ties, priority among what is ready, empty input). Your tests check exactly these.
Where the goal names something (a field, function, file, message, format or value), use exactly that name and shape: don't rename, nest or "improve" it. Do not edit files in this phase. The analysis stays in this conversation while you carry it out.`;

export const DECIDE_PROMPT =
  "[harness] That's enough exploring. Write your analysis now, from what you have read (framing, root causes, approach, steps, verification). No tool calls in this step.";

/** When to stop: the harness checks and reviews after the session, so extra proof is waste. */
const STOP_RULE =
  "Stop as soon as the tests pass and every point of the goal holds: the harness runs the project's checks and a review after you. Don't re-run tests that already passed, demonstrate old versus new behaviour, write scratch scripts or data, clean caches, or update todos, notes or memory unless the goal asks.";

export const EXECUTE_PROMPT = `[harness] Now carry out your analysis step by step, in this conversation. Batch independent edits in one turn. Run the relevant tests after each meaningful change and fix what fails. ${STOP_RULE} Then stop calling tools and summarize what you changed.`;

export const EXECUTE_REVISED_PROMPT = `[harness] Now carry out the revised analysis. Run the relevant tests as you go. ${STOP_RULE} Then stop calling tools and summarize.`;

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
  /** Turn cap for this segment (think steps), below the cycle's own. */
  maxTurns?: number;
  /** The analysis so far: a fold keeps it word for word. */
  pinned?: string;
}

export interface CheckOutcome {
  pass: boolean;
  /** What failed, for the next message (empty when it passed). */
  failures: string;
  /** Normalized failure text: the same signature twice means no progress. */
  signature: string;
  /** Git tree of the checked working tree. */
  tree: string;
  /** What the check measured, for the doom-loop breaker (no breaker without it). */
  state?: PassState;
}

export interface SessionIO {
  segment: (s: Segment, chain: ChainKind) => Promise<LoopResult>;
  check: () => Promise<CheckOutcome>;
  /**
   * Blocking findings of the end review, rendered; undefined when there are none (or it is off).
   * `messages` is the worker conversation at the green check, unchanged.
   */
  review?: (analysis: string, messages: readonly Message[]) => Promise<string | undefined>;
  /** Put the working tree back to a tree a check passed on. */
  restore: (tree: string) => Promise<void>;
  emit: (type: string, data: Record<string, unknown>) => void;
  /** A failure with this signature was just fixed; `summary` is what the agent says it did. */
  onFixed?: (signature: string, summary: string) => Promise<void>;
}

export interface SessionLimits {
  rounds: number;
  rethinks: number;
  /** Turns a think or re-think step may explore before it must write its analysis. */
  thinkTurns: number;
  /** Doom-loop rewinds allowed per session (0 or unset: no breaker). */
  rewinds?: number;
}

type Node = StateNode & { failures: string };

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
  maxTurns?: number;
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
  // Review findings handed back that the work since hasn't finished addressing.
  let findingsOpen = false;
  let rounds = 0;
  let rethinks = 0;
  let lastSignature = '';
  let rewinds = 0;
  let nodes: Node[] = [];
  // The checklist shown to the person comes from the analysis unless the model keeps its own.
  let seeded: string[] = [];
  let ownTodo = false;
  const seedTodo = (): void => {
    if (ownTodo) return;
    const steps = analysisSteps(analysis);
    if (!steps.length || steps.join('\n') === seeded.join('\n')) return;
    seeded = steps;
    io.emit('todo.update', { items: stepsTodo(steps), source: 'analysis' });
  };

  const run = async (step: Step | undefined): Promise<LoopResult> => {
    const seg = step ? continueWith(messages, step.text) : { history: [], first: anchor };
    const maxTurns = step ? step.maxTurns : limits.thinkTurns;
    const r = await io.segment(
      {
        ...seg,
        anchor,
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(analysis ? { pinned: analysis } : {}),
      },
      step?.chain ?? 'think',
    );
    messages = r.messages;
    ownTodo ||= wroteTodo(r.messages);
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
    // Findings whose fix was cut short (budget, stuck) don't count as reviewed: the cycle's own
    // review sees the final diff and rejects it if they still stand.
    const settled = reviewed && !(findingsOpen && last?.end !== 'done');
    if (seeded.length && !ownTodo && greenNow && end === 'done')
      io.emit('todo.update', { items: stepsTodo(seeded, true), source: 'analysis' });
    io.emit('loop.end', { end, rounds, rethinks, reviewed: settled, green: greenNow, turns });
    return {
      end,
      turns,
      finalText,
      usage,
      usd,
      messages,
      ...(last?.stuck && end === 'stuck' ? { stuck: last.stuck } : {}),
      analysis,
      reviewed: settled,
      rounds,
      rethinks,
      green: greenNow,
    };
  };

  // Thinking that ran out of exploring turns writes its analysis from what it has read.
  const decide = async (r: LoopResult): Promise<LoopResult> =>
    r.end === 'max_turns_per_cycle'
      ? run({ text: DECIDE_PROMPT, chain: 'think', thinking: true, maxTurns: 1 })
      : r;

  const thought = await decide(await run(undefined));
  io.emit('loop.think', { turns, chars: analysis.length, end: thought.end });
  if (TERMINAL.has(thought.end)) return finish(thought.end);
  seedTodo();

  let next: Step = { text: EXECUTE_PROMPT, chain: 'work', thinking: false };
  const rethink = (why: string): Step | undefined => {
    if (rethinks >= limits.rethinks) return undefined;
    rethinks++;
    io.emit('loop.rethink', { why: why.slice(0, 300), rethink: rethinks });
    return {
      text: rethinkPrompt(why),
      chain: 'think',
      thinking: true,
      maxTurns: limits.thinkTurns,
    };
  };

  while (rounds < limits.rounds) {
    const r = await run(next);
    if (TERMINAL.has(r.end)) return finish(r.end);
    if (next.thinking) {
      const decided = await decide(r);
      if (TERMINAL.has(decided.end)) return finish(decided.end);
      seedTodo();
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
    if (c.state)
      nodes = [
        ...nodes,
        {
          ...c.state,
          tree: c.tree,
          pass: c.pass,
          messageCount: messages.length,
          summary: r.finalText,
          key: c.pass ? '' : failKey(c.state.failIds),
          failures: c.failures,
        },
      ];
    if (c.pass) {
      if (lastSignature && io.onFixed) await io.onFixed(lastSignature, r.finalText);
      green = c.tree;
      greenNow = true;
      lastSignature = '';
      if (reviewed || !io.review) return finish('done');
      reviewed = true;
      const findings = await io.review(analysis, messages);
      io.emit('loop.review', { blocking: Boolean(findings) });
      if (!findings) return finish('done');
      findingsOpen = true;
      next = { text: reviewPrompt(findings), chain: 'work', thinking: false };
      continue;
    }
    const trip = rewinds < (limits.rewinds ?? 0) ? checkTrip(nodes) : undefined;
    if (trip) {
      // Doom loop: back to the best tree, the turns since become a tombstone, then re-think.
      rewinds++;
      const best = trip.best as Node;
      await io.restore(best.tree);
      messages = messages.slice(0, best.messageCount);
      nodes = nodes.slice(0, nodes.indexOf(best) + 1);
      greenNow = best.pass;
      lastSignature = '';
      const note = tombstone(trip);
      io.emit('loop.rewind', {
        reason: trip.reason,
        tree: best.tree,
        pruned: trip.since.length,
        rewind: rewinds,
      });
      const state = best.pass
        ? 'The best tree passed its checks.'
        : `The best tree's failures:\n${best.failures}`;
      const step = rethink(
        `${trip.reason === 'oscillation' ? 'going in circles' : 'checks getting worse'}\n${state}`,
      );
      next = step
        ? { ...step, text: `${note}\n\n${step.text}` }
        : {
            text: `${note}\n\n${best.pass ? EXECUTE_REVISED_PROMPT : fixPrompt(best.failures)}`,
            chain: 'work',
            thinking: false,
          };
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
