/**
 * Gate 3: triage long tool output before it joins the conversation. Runs on the new tool result
 * only, so earlier messages (and the cached prompt prefix) never change.
 */
import type { SystemOneClient } from './client.js';
import { hasErrorLine, type TriageClass } from './features.js';
import { choice, type ChoiceQuestion, type SystemOneBackendKind } from './types.js';

export const TRIAGE_OPTIONS: Record<TriageClass, string> = {
  relevant_error_trace:
    'Stack traces, failing assertions, compiler/type/lint errors, or direct answers needed to fix or verify the task',
  harmless_warnings:
    'Deprecation notices, peer-dependency warnings, progress bars, or non-fatal notices',
  irrelevant_noise:
    'Verbose install logs, passing test boilerplate, repetitive build chatter, or unrelated directory dumps',
};

const MIN_LINES = 40;
const MIN_CHARS = 2_000;
const CHUNK_LINES = 20;
const MAX_CHUNKS = 24;

export interface TriageResult {
  content: string;
  changed: boolean;
  linesPruned: number;
  warningLines: number;
  tokensSaved: number;
  backend: SystemOneBackendKind;
  latencyMs: number;
}

const tokens = (s: string): number => Math.ceil(s.length / 4);

export function chunkLines(lines: readonly string[]): string[][] {
  const size = Math.max(CHUNK_LINES, Math.ceil(lines.length / MAX_CHUNKS));
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
  return out;
}

export function needsTriage(output: string): boolean {
  return output.length > MIN_CHARS || output.split('\n').length > MIN_LINES;
}

/** Consecutive chunks of one class, merged so a long run of noise collapses to one marker. */
function groups(
  chunks: readonly string[][],
  classes: readonly TriageClass[],
): { cls: TriageClass; lines: string[] }[] {
  const out: { cls: TriageClass; lines: string[] }[] = [];
  chunks.forEach((lines, i) => {
    const cls = classes[i] ?? 'relevant_error_trace';
    const prev = out.at(-1);
    if (prev?.cls === cls) prev.lines.push(...lines);
    else out.push({ cls, lines: [...lines] });
  });
  return out;
}

function render(
  chunks: readonly string[][],
  classes: readonly TriageClass[],
): { text: string; pruned: number; warnings: number } {
  const out: string[] = [];
  let pruned = 0;
  let warnings = 0;
  const all = groups(chunks, classes);
  all.forEach(({ cls, lines }, i) => {
    if (cls === 'relevant_error_trace') out.push(...lines);
    else if (cls === 'harmless_warnings') {
      out.push(`[system1:triage collapsed ${String(lines.length)} warning lines]`);
      warnings += lines.length;
    } else {
      // Keep the head, and the tail of the final group (exit codes and summaries live there).
      const keepTail = i === all.length - 1 ? 2 : 0;
      const dropped = Math.max(0, lines.length - 1 - keepTail);
      if (dropped < 3) out.push(...lines);
      else {
        out.push(
          lines[0] ?? '',
          `[system1:triage pruned ${String(dropped)} noise lines — full output via read_log if needed]`,
          ...(keepTail ? lines.slice(-keepTail) : []),
        );
        pruned += dropped;
      }
    }
  });
  return { text: out.join('\n'), pruned, warnings };
}

export async function triageOutput(
  client: SystemOneClient,
  output: string,
  tool: string,
): Promise<TriageResult> {
  const lines = output.split('\n');
  const chunks = chunkLines(lines);
  const texts = chunks.map((c) => c.join('\n'));
  const questions: Record<string, ChoiceQuestion<TriageClass>> = {};
  texts.forEach((_, i) => {
    questions[`chunk_${String(i)}`] = choice(
      `Classify output chunk ${String(i)} of this ${tool} result for the coding agent's context window.`,
      TRIAGE_OPTIONS,
    );
  });
  const r = await client.systemOne({ gate: 'triage', state: { tool, chunks: texts }, questions });
  const classes = texts.map((t, i): TriageClass => {
    const remote = r.answers[`chunk_${String(i)}`]?.choice ?? 'relevant_error_trace';
    // Never drop a chunk the calibrated features see an error in.
    return hasErrorLine(t) ? 'relevant_error_trace' : remote;
  });
  const { text, pruned, warnings } = render(chunks, classes);
  const changed = pruned > 0 || warnings > 0;
  return {
    content: changed ? text : output,
    changed,
    linesPruned: pruned,
    warningLines: warnings,
    tokensSaved: changed ? Math.max(0, tokens(output) - tokens(text)) : 0,
    backend: r.backend,
    latencyMs: r.latencyMs,
  };
}
