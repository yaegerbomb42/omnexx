import type { Baseline } from '../core/run-store.js';
import type { GateResult } from './gates.js';
import type { Failure } from './parsers/types.js';
import type { GateVerdict } from './ratchet.js';

/**
 * Typed failure handling: before failing gates go back to the agent, sort them into
 * pre-existing (in the baseline), flaky (passed on a re-run), environment/tooling (a typed hint),
 * and real failures (a compact Failure Packet: test names, the first relevant assertion and
 * project stack frames, and the diff hunks touching those files). The raw log stays readable
 * through read_log; it is no longer pasted into the conversation.
 */

export type FailureKind = 'pre-existing' | 'flaky' | 'env' | 'real';

/** The whole feedback text, at most this many characters. */
export const PACKET_CHARS = 3_000;
/** Real failures listed per gate. */
const MAX_FAILURES = 6;
/** Assertion and stack lines kept per failure. */
const MAX_LINES = 6;
/** Diff hunk lines kept per touched file. */
const MAX_HUNK_LINES = 12;

interface EnvRule {
  test: RegExp;
  hint: (m: RegExpMatchArray) => string;
}

const missingCommand = (m: RegExpMatchArray): string =>
  `command \`${m[1] ?? '?'}\` is not installed or not on PATH: install it or use the project's own script (npx/npm run).`;

const ENV_RULES: readonly EnvRule[] = [
  { test: /command not found:?\s*([\w.-]+)/i, hint: missingCommand },
  { test: /([\w.-]+): (?:command )?not found/i, hint: missingCommand },
  {
    test: /(?:environment variable|env var)\s+[`'"]?([A-Z][A-Z0-9_]+)[`'"]?\s+(?:is )?(?:not set|missing|required|undefined)|missing (?:required )?(?:environment variable|env var)[:\s]+[`'"]?([A-Z][A-Z0-9_]+)/i,
    hint: (m) =>
      `environment variable ${m[1] ?? m[2] ?? '?'} is missing: give it a test default or read it optionally; don't hard-code a secret.`,
  },
  {
    test: /Cannot find (?:module|package) ['"]((?:@[\w.-]+\/)?[\w.-]+)[^'"]*['"]/,
    hint: (m) =>
      `dependency \`${m[1] ?? '?'}\` is not installed: add it to the manifest and install, or drop the import.`,
  },
  {
    test: /ModuleNotFoundError: No module named ['"]([\w.]+)['"]/,
    hint: (m) =>
      `Python module \`${m[1] ?? '?'}\` is not installed: add it to the requirements and install it.`,
  },
  {
    test: /EADDRINUSE[^\n]*?(\d{2,5})?\b|address already in use/i,
    hint: (m) =>
      `port ${m[1] ?? ''} is already in use: something from an earlier run is still listening; use a free port (PORT env) or stop it.`.replace(
        '  ',
        ' ',
      ),
  },
];

/** A typed hint when the failure text looks like an environment or tooling problem. */
export function envHint(text: string): string | undefined {
  for (const r of ENV_RULES) {
    const m = text.match(r.test);
    // A relative import that doesn't resolve is the agent's own bug, not a missing dependency.
    if (m && !(m[1]?.startsWith('.') ?? false)) return r.hint(m);
  }
  return undefined;
}

const DEP_FRAME = /node_modules|site-packages|node:internal|<anonymous>|\(internal\//;
const STACK_FRAME = /^\s*(at |File "|\S+\.\w+:\d+)/;

/** The first assertion lines and project-file stack frames of one failure message. */
export function relevantLines(message: string): string[] {
  const lines = message.split('\n').filter((l) => l.trim());
  const head = lines.filter((l) => !STACK_FRAME.test(l)).slice(0, 3);
  const frames = lines.filter((l) => STACK_FRAME.test(l) && !DEP_FRAME.test(l)).slice(0, 3);
  return [...head, ...frames].slice(0, MAX_LINES).map((l) => l.trimEnd().slice(0, 200));
}

const FILE_IN =
  /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|kt|swift|c|cc|cpp|h))\b/g;

/** Project files a failure points to (its location and stack frames outside dependencies). */
export function filesOf(f: Failure): string[] {
  const text = [
    f.location ?? '',
    f.id,
    ...f.message.split('\n').filter((l) => !DEP_FRAME.test(l)),
  ].join('\n');
  return [...new Set([...text.matchAll(FILE_IN)].map((m) => (m[1] ?? '').replace(/^\.\//, '')))];
}

/** The hunks of a unified diff that touch `file`, clipped. */
export function hunksFor(patch: string, file: string): string {
  const sections = patch.split(/^(?=diff --git )/m);
  const sec = sections.find(
    (s) => s.startsWith('diff --git ') && s.split('\n')[0]?.endsWith(`b/${file}`),
  );
  if (!sec) return '';
  const body = sec.split('\n').filter((l) => /^[@+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  const kept = body.slice(0, MAX_HUNK_LINES);
  return [
    ...kept,
    ...(body.length > kept.length ? [`… (${body.length - kept.length} more)`] : []),
  ].join('\n');
}

export interface TriageInput {
  results: readonly GateResult[];
  verdicts: readonly GateVerdict[];
  baseline: Baseline | undefined;
  /** Failure ids that failed and then passed on a re-run, this run (quarantined). */
  flaky: ReadonlySet<string>;
  /** The working-tree diff, for the hunks that touch failing files. */
  patch: string;
}

export interface TriagedFailure {
  kind: FailureKind;
  gate: string;
  failure: Failure;
  hint?: string;
}

/** Sort every failure of every gate into one of the four kinds. */
export function classify(input: TriageInput): TriagedFailure[] {
  const out: TriagedFailure[] = [];
  for (const [i, r] of input.results.entries()) {
    const v = input.verdicts[i];
    const base = new Set(input.baseline?.[r.name]?.failureIds ?? []);
    for (const f of r.failures) {
      if (base.has(f.id)) out.push({ kind: 'pre-existing', gate: r.name, failure: f });
      else if (input.flaky.has(f.id)) out.push({ kind: 'flaky', gate: r.name, failure: f });
      else {
        const hint = envHint(`${f.id}\n${f.message}`);
        if (hint) out.push({ kind: 'env', gate: r.name, failure: f, hint });
        else if (v && !v.pass) out.push({ kind: 'real', gate: r.name, failure: f });
      }
    }
  }
  return out;
}

/** Render the triaged failures as the compact text the agent gets back. */
export function renderTriage(
  items: readonly TriagedFailure[],
  input: Pick<TriageInput, 'results' | 'verdicts' | 'patch'>,
): string {
  const of = (k: FailureKind) => items.filter((x) => x.kind === k);
  const out: string[] = [];
  const env = of('env');
  if (env.length) {
    const hints = [...new Set(env.map((x) => x.hint ?? ''))];
    out.push(
      `Environment/tooling (fix the setup, not the code):\n${hints.map((h) => `- ${h}`).join('\n')}`,
    );
  }
  for (const [i, r] of input.results.entries()) {
    const v = input.verdicts[i];
    if (!v || v.pass) continue;
    const real = of('real').filter((x) => x.gate === r.name);
    out.push(
      `Gate ${r.name}: ${v.reason ?? 'failed'}${real.length ? '' : ' (no parsed failures; see read_log)'}`,
    );
    const files = new Set<string>();
    for (const x of real.slice(0, MAX_FAILURES)) {
      const where = x.failure.location ? ` (${x.failure.location})` : '';
      out.push(`- ${x.failure.id}${where}\n  ${relevantLines(x.failure.message).join('\n  ')}`);
      for (const f of filesOf(x.failure)) files.add(f);
    }
    if (real.length > MAX_FAILURES) out.push(`- … ${real.length - MAX_FAILURES} more`);
    for (const f of files) {
      const h = hunksFor(input.patch, f);
      if (h) out.push(`Your diff in ${f}:\n${h}`);
    }
    out.push(`Full log: read_log ${r.logFile}`);
  }
  const pre = of('pre-existing');
  if (pre.length)
    out.push(
      `${pre.length} failure(s) were already failing before this run (${pre
        .slice(0, 3)
        .map((x) => x.failure.id)
        .join(
          ', ',
        )}${pre.length > 3 ? ', …' : ''}): pre-existing, not your job unless the goal says so, and not counted against you.`,
    );
  const flaky = of('flaky');
  if (flaky.length)
    out.push(
      `Flaky, quarantined for this run (failed, then passed on a re-run): ${flaky
        .map((x) => x.failure.id)
        .slice(0, 5)
        .join(', ')}.`,
    );
  const text = out.join('\n\n');
  return text.length > PACKET_CHARS ? `${text.slice(0, PACKET_CHARS - 1)}…` : text;
}
