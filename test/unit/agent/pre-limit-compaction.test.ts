import { describe, expect, it } from 'vitest';
import {
  contextTokens,
  isOverflowError,
  manageContext,
  renderSummary,
  stagedSummary,
  type CompactionEvent,
  type CompactionSettings,
  type CycleSummary,
  type Summarize,
} from '../../../src/agent/compaction.js';
import { buildOversizedTranscript, firstMessage } from '../../support/compaction-transcript.js';

const WINDOW = 6_000;

const okSummary: CycleSummary = {
  done: ['folded a chunk'],
  inProgress: 'staged merge',
  filesTouched: [],
  nextStep: 'continue from merged state',
};

/** Settings that keep every tool result intact so the head genuinely overflows the summarizer. */
const settings: CompactionSettings = {
  budget: WINDOW,
  clearAt: Number.MAX_SAFE_INTEGER,
  keepToolResults: Number.MAX_SAFE_INTEGER,
  compactAt: Number.MAX_SAFE_INTEGER,
  keepTurns: 2,
  compactAtFraction: 0.75,
};

/** Summarizer that overflows (like Claude Code #26317) when the head alone exceeds the window. */
function makeOverflowingSummarizer(counter: { calls: number }): Summarize {
  return (head) => {
    counter.calls++;
    if (contextTokens(head) > WINDOW) {
      return Promise.reject(
        new Error('prompt is too long: conversation exceeds the context window'),
      );
    }
    return Promise.resolve(okSummary);
  };
}

describe('pre-limit staged compaction', () => {
  it('folds a 1.3x-window transcript in <=3 calls and lands under 50% of the window', async () => {
    const { messages, rawTokens } = buildOversizedTranscript(WINDOW, 1.3);
    expect(rawTokens).toBeGreaterThanOrEqual(WINDOW * 1.3);

    const counter = { calls: 0 };
    const events: CompactionEvent[] = [];
    const out = await manageContext(
      messages,
      firstMessage,
      settings,
      makeOverflowingSummarizer(counter),
      (e) => events.push(e),
    );

    // 1 whole-head attempt (overflows) + 2 chunk summaries = 3 calls, never more.
    expect(counter.calls).toBeLessThanOrEqual(3);
    expect(counter.calls).toBe(3);
    expect(events.some((e) => e.kind === 'compacted')).toBe(true);
    expect(events.some((e) => e.kind === 'compact_failed')).toBe(false);

    const after = contextTokens(out);
    expect(after).toBeLessThan(WINDOW * 0.5);
    // The fold actually happened: Slot 7 working state is present in the first message.
    expect(JSON.stringify(out[0])).toContain('# Working state');
  });

  it('stagedSummary summarizes oldest chunks first and merges them', async () => {
    const { messages } = buildOversizedTranscript(WINDOW, 1.3);
    const head = messages.slice(1, messages.length - 4);
    const seen: number[] = [];
    const summarize: Summarize = (chunk) => {
      seen.push(contextTokens(chunk));
      return Promise.resolve({ ...okSummary, inProgress: `chunk ${seen.length}` });
    };
    const merged = await stagedSummary(head, undefined, summarize);
    expect(seen).toHaveLength(2);
    // Oldest chunk is summarized first; both halves are smaller than the whole head.
    expect(seen[0]).toBeLessThan(contextTokens(head));
    expect(merged?.inProgress).toBe('chunk 2');
    expect(merged?.done.length).toBeGreaterThan(0);
  });

  it('detects provider overflow errors but not unrelated failures', () => {
    expect(isOverflowError(new Error('prompt is too long'))).toBe(true);
    expect(isOverflowError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isOverflowError(new Error('conversation too long'))).toBe(true);
    expect(isOverflowError(new Error('network socket hang up'))).toBe(false);
    expect(isOverflowError(new Error('401 unauthorized'))).toBe(false);
  });

  it('still reports compact_failed for a non-overflow summarize rejection', async () => {
    const { messages } = buildOversizedTranscript(WINDOW, 1.3);
    const events: CompactionEvent[] = [];
    const summarize: Summarize = () => Promise.reject(new Error('upstream 503'));
    const out = await manageContext(messages, firstMessage, settings, summarize, (e) =>
      events.push(e),
    );
    const failed = events.find((e) => e.kind === 'compact_failed');
    expect(failed).toMatchObject({ kind: 'compact_failed', reason: 'upstream 503' });
    expect(events.some((e) => e.kind === 'compacted')).toBe(false);
    // No fold happened, so Slot 7 working state is absent; the budget guard still caps the size.
    expect(JSON.stringify(out[0])).not.toContain('# Working state');
    expect(contextTokens(out)).toBeLessThanOrEqual(WINDOW);
  });

  it('renders a merged staged summary into the working state', () => {
    const text = renderSummary(okSummary);
    expect(text).toContain('staged merge');
    expect(text).toContain('# Working state');
  });
});
