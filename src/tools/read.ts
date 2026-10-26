import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { estimateTokens } from '../core/tokens.js';
import { lineTag } from './anchors.js';
import { openError } from './did-you-mean.js';
import { extractSymbols, renderOutline } from './outline.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from './types.js';

export const MAX_READ_LINES = 400;
/** Longer lines (minified or generated code) are clipped; search finds text inside them. */
export const MAX_LINE_CHARS = 2_000;
/** One read returns at most this much (~20k tokens); a range past it ends early. */
export const MAX_READ_CHARS = 60_000;

/** Files one read may take through `files`. */
export const MAX_READ_FILES = 10;
/** Below this much of a multi-file read's budget, a file isn't started: a few lines only cost a re-read. */
const MIN_SECTION_CHARS = 2_000;

const start = z.number().int().positive().optional();
const end = z.number().int().positive().optional();

const schema = z.strictObject({
  path: z.string().optional().describe('Path relative to the repo root'),
  start,
  end,
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        start,
        end,
      }),
    )
    .min(1)
    .max(MAX_READ_FILES)
    .optional()
    .describe(`Several files or ranges (up to ${MAX_READ_FILES})`),
  anchors: z.boolean().optional().describe('Hash lines for replace_lines'),
  note: z.string().max(280).optional().describe('What you learned; unchanged re-reads return this'),
  refresh: z.boolean().optional().describe('Force bytes even if unchanged'),
});

interface ReadTarget {
  path: string;
  start?: number | undefined;
  end?: number | undefined;
  note?: string | undefined;
}

function clipLine(l: string): string {
  if (l.length <= MAX_LINE_CHARS) return l;
  return `${l.slice(0, MAX_LINE_CHARS)}… [line is ${l.length} chars; search for text in it]`;
}

/** One file (or range of it), shown in at most `maxChars`. */
async function readOne(
  t: ReadTarget,
  anchors: boolean | undefined,
  ctx: ToolContext,
  maxChars: number,
  refresh?: boolean,
): Promise<ToolOutput> {
  let text: string;
  try {
    text = await readFile(await resolvePath(ctx, t.path, 'read'), 'utf8');
  } catch (err) {
    return fail(await openError(ctx, t.path, err, '', 'read'));
  }
  if (text.includes('\0')) return fail(`${t.path} looks binary; not shown`);
  const lines = text.split('\n');
  if (t.start === undefined && t.end === undefined && lines.length > MAX_READ_LINES) {
    return ok(
      `${t.path} has ${lines.length} lines; read it by range (start/end). Outline:\n${renderOutline(extractSymbols(text), lines.length)}`,
    );
  }
  const first = t.start ?? 1;
  if (t.end !== undefined && t.end < first) {
    return fail(`${t.path}: start line (${first}) cannot be greater than end line (${t.end})`);
  }
  let last = Math.min(t.end ?? lines.length, first + MAX_READ_LINES - 1, lines.length);
  if (first > lines.length) return fail(`${t.path} has only ${lines.length} lines`);
  const shown: string[] = [];
  let size = 0;
  for (let n = first; n <= last; n++) {
    const l = lines[n - 1] ?? '';
    const tag = anchors ? ` ${lineTag(l)}` : ' ';
    const row = `${String(n).padStart(5)}${tag} ${clipLine(l)}`;
    if (shown.length && size + row.length > maxChars) {
      last = n - 1;
      break;
    }
    shown.push(row);
    size += row.length + 1;
  }
  const body = shown.join('\n');
  const more = last < lines.length ? `\n(lines ${last + 1}-${lines.length} not shown)` : '';
  const shownText = `${body}${more}`;
  const step = ctx.turn ?? ctx.cycle;
  // The guard measures itself against a no-guard run in bench: `OMNEXX_READ_GUARD=off`.
  // It is not a user-facing switch; normal runs always keep the guard on.
  const repeat =
    ctx.reads && !refresh && process.env.OMNEXX_READ_GUARD !== 'off'
      ? alreadyShown(ctx.reads, t.path, text, first, last, anchors, {
          step,
          cycle: ctx.cycle,
          ...(t.note ? { note: t.note } : {}),
        })
      : undefined;
  if (repeat) {
    // What the model would have paid for these bytes had the guard not answered.
    const fullTokens = estimateTokens(shownText);
    const savedTokens =
      repeat.mode === 'diff' ? Math.max(0, fullTokens - estimateTokens(repeat.text)) : fullTokens;
    ctx.events.emit('read.dedup', {
      path: t.path,
      fromStep: repeat.fromStep,
      turn: ctx.turn,
      cycle: ctx.cycle,
      savedTokens,
      savedChars: Math.max(0, shownText.length - repeat.text.length),
      range: `${String(first)}-${String(last)}`,
      mode: repeat.mode,
    });
    return { content: repeat.text, ...(savedTokens ? { savedTokens } : {}) };
  }
  return ok(shownText);
}

/** Header of one file's section in a multi-file read. */
function heading(t: ReadTarget): string {
  const range =
    t.start !== undefined || t.end !== undefined
      ? ` (lines ${String(t.start ?? 1)}-${t.end === undefined ? 'end' : String(t.end)})`
      : '';
  return `== ${t.path}${range} ==`;
}

/**
 * Several files in one call, each under its own heading, sharing one MAX_READ_CHARS budget.
 * A file that can't be read is reported in its section; the call fails only if none could be.
 */
async function readMany(
  targets: readonly ReadTarget[],
  anchors: boolean | undefined,
  ctx: ToolContext,
  refresh?: boolean,
): Promise<ToolOutput> {
  // In order, each with what's left of the budget: one read per file, so the already-shown
  // bookkeeping sees each range once.
  const sections: string[] = [];
  let left = MAX_READ_CHARS;
  let failed = 0;
  let savedTokens = 0;
  for (const t of targets) {
    if (left < MIN_SECTION_CHARS) {
      sections.push(`${heading(t)}\n(not read: this call reached its size limit; read it next)`);
      continue;
    }
    const out = await readOne(t, anchors, ctx, left, refresh);
    if (out.isError) failed++;
    savedTokens += out.savedTokens ?? 0;
    sections.push(`${heading(t)}\n${out.content}`);
    left -= out.content.length;
  }
  const content = sections.join('\n\n');
  const result = failed === targets.length ? fail(content) : ok(content);
  return savedTokens ? { ...result, savedTokens } : result;
}

export const readTool: Tool<typeof schema> = {
  name: 'read',
  description: `Read files with line numbers; a long file needs a range.`,
  schema,
  readOnly: true,
  concurrent: true,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const rest = { ...raw };
    delete rest.paths;
    delete rest.start_line;
    delete rest.end_line;
    const files = raw.files ?? raw.paths;
    return {
      ...rest,
      start: raw.start ?? raw.start_line,
      end: raw.end ?? raw.end_line,
      ...(files !== undefined ? { files } : {}),
    };
  },
  async run(input, ctx) {
    if (input.files && input.path !== undefined)
      return fail('read takes either path (with start/end) or files: [...], not both');
    if (input.files)
      return readMany(
        input.files.map((f) => ({ ...f, ...(input.note ? { note: input.note } : {}) })),
        input.anchors,
        ctx,
        input.refresh,
      );
    if (input.path === undefined) return fail('read needs path, or files: [{path, start, end}]');
    return readOne(
      {
        path: input.path,
        start: input.start,
        end: input.end,
        ...(input.note ? { note: input.note } : {}),
      },
      input.anchors,
      ctx,
      MAX_READ_CHARS,
      input.refresh,
    );
  },
};

/** What an earlier read of a path saw, kept in the reads cache under `cov:<path>`. */
interface SeenRead {
  hash: string;
  ranges: [number, number][];
  /** The step (model turn) and cycle the file was first read at. */
  step: number;
  cycle?: number;
  /** The agent's own note from an earlier read, if it gave one. */
  note?: string;
  /** First useful lines, so a repeat read still carries a hint when no note was written. */
  preview?: string;
  /** The bytes as read, so a later re-read after an edit can return a diff, not the file. */
  text?: string;
}

function parseCoverage(value: string | undefined): SeenRead {
  if (!value) return { hash: '', ranges: [], step: 0 };
  try {
    const parsed = JSON.parse(value) as Partial<SeenRead>;
    return {
      hash: typeof parsed.hash === 'string' ? parsed.hash : '',
      ranges: Array.isArray(parsed.ranges)
        ? parsed.ranges.filter(
            (r): r is [number, number] =>
              Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number',
          )
        : [],
      step: typeof parsed.step === 'number' ? parsed.step : 0,
      ...(typeof parsed.cycle === 'number' ? { cycle: parsed.cycle } : {}),
      ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
      ...(typeof parsed.preview === 'string' ? { preview: parsed.preview } : {}),
      ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
    };
  } catch {
    // A cache from an older build (`hash|1-4,7-9`) still guards correctly; its step is unknown.
    const [hash = '', list = ''] = value.split('|');
    const ranges = list
      .split(',')
      .filter(Boolean)
      .map((r) => r.split('-').map(Number) as [number, number]);
    return { hash, ranges, step: 0 };
  }
}

const covers = (ranges: readonly [number, number][], start: number, end: number): boolean => {
  for (let n = start; n <= end; n++) if (!ranges.some(([a, b]) => n >= a && n <= b)) return false;
  return true;
};

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/** The first couple of non-empty lines, as a hint when the agent wrote no note. */
function previewOf(text: string): string {
  return clip(
    text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 2)
      .join(' / '),
    180,
  );
}

/**
 * A short note instead of the lines when the file's bytes are unchanged and every requested line
 * was already shown this cycle. If the bytes changed, return only the changed hunks (the agent
 * still has the earlier bytes in this conversation). The note names the step, carries the agent's
 * earlier note (or a preview), and says how to force the bytes (`refresh: true`) if needed.
 */
function alreadyShown(
  reads: Map<string, string>,
  path: string,
  text: string,
  start: number,
  end: number,
  anchors: boolean | undefined,
  meta: { step: number; cycle: number; note?: string },
): { text: string; fromStep: number; mode: 'unchanged' | 'diff' } | undefined {
  const covKey = `cov:${path}${anchors ? ':a' : ''}`;
  const hash = createHash('sha256').update(text).digest('hex');
  const seen = parseCoverage(reads.get(covKey));
  const range = `${String(start)}-${String(end)}`;
  const store = (next: SeenRead): void => {
    // Large generated files are not worth keeping twice; they simply lose the diff fast path.
    reads.set(
      covKey,
      JSON.stringify({
        ...next,
        ...(next.text && next.text.length > MAX_READ_CHARS * 4 ? { text: undefined } : {}),
      }),
    );
  };
  if (seen.hash === hash && covers(seen.ranges, start, end)) {
    const note = seen.note ?? meta.note;
    const noteText = note
      ? `your earlier note: "${clip(note, 240)}"`
      : seen.preview
        ? `earlier content began: ${seen.preview}`
        : 'no note was recorded';
    return {
      mode: 'unchanged',
      fromStep: seen.step || meta.step,
      text: `${path} is unchanged since step ${String(seen.step || meta.step)}${seen.cycle ? ` (cycle ${String(seen.cycle)})` : ''}; lines ${range} were already shown. ${noteText}. Use that result above, or read with refresh: true for the bytes again.`,
    };
  }
  if (seen.hash && seen.hash !== hash && seen.text && covers(seen.ranges, start, end)) {
    const before = seen.text.split('\n').slice(start - 1, end);
    const after = text.split('\n').slice(start - 1, end);
    const diff = unifiedDiff(before, after, start);
    if (diff) {
      // The earlier bytes are in this cycle's context; only the delta is new information.
      store({
        hash,
        ranges: seen.ranges,
        step: seen.step || meta.step,
        cycle: seen.cycle ?? meta.cycle,
        ...((meta.note ?? seen.note) ? { note: meta.note ?? seen.note } : {}),
        preview: seen.preview ?? previewOf(text),
        text,
      });
      return {
        mode: 'diff',
        fromStep: seen.step || meta.step,
        text: `${path} changed since step ${String(seen.step || meta.step)}${seen.cycle ? ` (cycle ${String(seen.cycle)})` : ''}; showing only changed lines (unchanged lines are in your earlier read).\n${diff}\n(read with refresh: true for the full file)`,
      };
    }
  }
  const ranges =
    seen.hash === hash
      ? [...seen.ranges, [start, end] as [number, number]]
      : [[start, end] as [number, number]];
  const next: SeenRead = {
    hash,
    ranges,
    step: seen.hash === hash && seen.step ? seen.step : meta.step,
    cycle: seen.hash === hash && seen.cycle ? seen.cycle : meta.cycle,
    ...((meta.note ?? seen.note) ? { note: meta.note ?? seen.note } : {}),
    preview: seen.hash === hash && seen.preview ? seen.preview : previewOf(text),
    text,
  };
  store(next);
  return undefined;
}

/** Longest common subsequence of two line arrays, as edit operations for the readable diff. */
function unifiedDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
  offset: number,
): string {
  const n = oldLines.length;
  const m = newLines.length;
  if (!n && !m) return '';
  // n and m are at most MAX_READ_LINES; a flat table keeps this simple and bounded.
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
  const ops: { kind: ' ' | '-' | '+'; line: string; oldLine: number; newLine: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: ' ', line: oldLines[i] ?? '', oldLine: offset + i, newLine: offset + j });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) {
      ops.push({ kind: '-', line: oldLines[i] ?? '', oldLine: offset + i, newLine: offset + j });
      i++;
    } else {
      ops.push({ kind: '+', line: newLines[j] ?? '', oldLine: offset + i, newLine: offset + j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: oldLines[i] ?? '', oldLine: offset + i, newLine: offset + j });
    i++;
  }
  while (j < m) {
    ops.push({ kind: '+', line: newLines[j] ?? '', oldLine: offset + i, newLine: offset + j });
    j++;
  }
  // Keep two lines of context around each change so the diff still reads like a hunk.
  const keep = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, idx - 2); k <= Math.min(ops.length - 1, idx + 2); k++) keep.add(k);
  });
  if (!keep.size) return '';
  const out: string[] = [];
  let last = -2;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep.has(idx)) continue;
    const op = ops[idx];
    if (!op) continue;
    if (idx !== last + 1)
      out.push(`@@ old line ${String(op.oldLine)} / new line ${String(op.newLine)} @@`);
    out.push(`${op.kind}${clipLine(op.line)}`);
    last = idx;
  }
  return out.join('\n');
}
