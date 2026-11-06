/**
 * Gate 4: classify the user's intent before the first frontier call and, for read-only
 * investigations, pre-fetch what the model would have asked for first (a symbol search, or the
 * git state). The findings ride in the user turn, after the cached system/tools prefix.
 */
import { execFile } from 'node:child_process';
import type { SystemOneClient } from './client.js';
import { INTENT_KEYS, type IntentClass } from './features.js';
import type { SystemOneBackendKind } from './types.js';

export const INTENT_QUESTION = 'What does the user want the coding agent to do first?';

export const INTENT_OPTIONS: Record<IntentClass, string> = {
  explain_code: 'Locate or explain how symbols, files, or architecture work',
  edit_code: 'Implement, refactor, or fix code in files',
  run_command: 'Run tests, builds, benchmarks, or terminal commands',
  git_operation: 'Inspect git status, diff, log, branches, or commits',
  ask_clarification: 'Ambiguous or conversational prompt needing clarification or direct reply',
};

export interface IntentVerdict {
  intent: IntentClass;
  confidence: number;
  probabilities: Record<IntentClass, number>;
  backend: SystemOneBackendKind;
  latencyMs: number;
}

export async function classifyIntent(
  client: SystemOneClient,
  prompt: string,
): Promise<IntentVerdict> {
  const r = await client.choice({
    gate: 'intent',
    state: { prompt: prompt.slice(0, 2_000) },
    question: INTENT_QUESTION,
    options: INTENT_OPTIONS,
  });
  const intent = (INTENT_KEYS as readonly string[]).includes(r.choice)
    ? r.choice
    : 'ask_clarification';
  return {
    intent,
    confidence: r.confidence,
    probabilities: r.probabilities,
    backend: r.backend,
    latencyMs: r.latencyMs,
  };
}

const STOP = new Set(
  'the and are for how was were its you all not but has can show where what which when does that this with from into about there their have make code file files find look tell explain please could would should them they used uses work works check checked handle handled defined implemented called repo project function functions'.split(
    ' ',
  ),
);

/** Search terms from a prompt: identifiers and content words, singularized, most specific first. */
export function searchTerms(prompt: string): string[] {
  const words = prompt.match(/[A-Za-z_]\w{2,}/g) ?? [];
  const seen = new Set<string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (STOP.has(lower) || lower.length < 3) continue;
    seen.add(lower.length > 4 && lower.endsWith('s') ? lower.slice(0, -1) : lower);
  }
  return [...seen].slice(0, 5);
}

export type Runner = (cmd: string, args: readonly string[], cwd: string) => Promise<string>;

export const runCommand: Runner = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd, timeout: 1_500, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      // rg/grep exit 1 when nothing matched: that's an empty answer, not a failure.
      if (err && err.code !== 1) reject(new Error(err.message, { cause: err }));
      else resolve(stdout);
    });
  });

const MAX_HITS = 25;

/** Rank `path:line:text` hits by how many distinct terms they mention. */
export function rankHits(raw: string, terms: readonly string[]): string[] {
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => ({
      l: l.length > 200 ? `${l.slice(0, 197)}...` : l,
      n: terms.filter((t) => l.toLowerCase().includes(t)).length,
    }))
    .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l))
    .slice(0, MAX_HITS)
    .map((x) => x.l);
}

async function symbolSearch(
  prompt: string,
  root: string,
  run: Runner,
): Promise<string | undefined> {
  const terms = searchTerms(prompt);
  if (!terms.length) return undefined;
  const pattern = terms.join('|');
  let raw: string;
  try {
    raw = await run(
      'rg',
      [
        '-n',
        '-i',
        '-S',
        '--max-count',
        '5',
        '--max-columns',
        '200',
        '-g',
        '!node_modules',
        '-g',
        '!dist',
        '-g',
        '!*.lock',
        '-e',
        pattern,
      ],
      root,
    );
  } catch {
    raw = await run('git', ['grep', '-n', '-i', '-E', pattern], root).catch(() => '');
  }
  const hits = rankHits(raw, terms);
  if (!hits.length) return undefined;
  return `search for ${terms.join(', ')} (${String(hits.length)} best hits):\n${hits.join('\n')}`;
}

async function gitState(root: string, run: Runner): Promise<string | undefined> {
  const [status, stat] = await Promise.all([
    run('git', ['status', '-sb'], root).catch(() => ''),
    run('git', ['diff', '--stat'], root).catch(() => ''),
  ]);
  const body = [
    status.trim() && `$ git status -sb\n${status.trim()}`,
    stat.trim() && `$ git diff --stat\n${stat.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return body ? body.split('\n').slice(0, 60).join('\n') : undefined;
}

/** Read-only pre-fetch for an investigative intent; undefined when there is nothing to add. */
export async function speculate(
  intent: IntentClass,
  prompt: string,
  root: string,
  run: Runner = runCommand,
): Promise<string | undefined> {
  if (intent === 'explain_code') return symbolSearch(prompt, root, run);
  if (intent === 'git_operation') return gitState(root, run);
  return undefined;
}

export function speculativeBlock(
  intent: IntentClass,
  confidence: number,
  findings: string,
): string {
  return `[system1:speculative ${intent} · ${String(Math.round(confidence * 100))}%] Already gathered before your first turn (read-only); use it instead of re-running the same search:\n${findings}`;
}
