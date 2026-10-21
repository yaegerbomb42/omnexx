import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { openError } from './did-you-mean.js';
import { missText } from './edit-recovery.js';
import { fuzzyReplace } from './fuzzy-match.js';
import {
  afterEdit,
  diagnoseInMemory,
  preWriteSyntaxCheck,
  renderAnchoredSnippet,
} from './post-edit.js';
import { fail, ok, resolvePath, type Tool, type ToolContext, type ToolOutput } from './types.js';

/** 1-based line numbers where `needle` starts in `text` (the first ten). */
function linesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let at = text.indexOf(needle);
  while (at >= 0 && out.length < 10) {
    out.push(text.slice(0, at).split('\n').length);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

export const WRITE_MAX_LINES = 250;
export const ECHO_SNIPPET_LINES = 20;

const editSchema = z.strictObject({ old_str: z.string().min(1), new_str: z.string() });

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

type OneResult =
  | {
      text: string;
      /** Alternate text without automatic re-indentation when fuzzy matching triggered. */
      altText?: string;
      note?: string;
      focusLine: number;
    }
  | { error: string; miss?: true };

/** Compute the 1-based center line of a newly applied replacement snippet. */
function computeFocusLine(beforeText: string, matchIndex: number, newStr: string): number {
  const startLine = beforeText.slice(0, matchIndex).split('\n').length;
  const newSpan = newStr.split('\n').length;
  return startLine + Math.floor(newSpan / 2);
}

/** One edit: an exact unique match, else a unique whitespace-insensitive one, else an error. */
function applyOne(
  text: string,
  e: z.infer<typeof editSchema>,
  index: number,
  path: string,
): OneResult {
  const n = countOccurrences(text, e.old_str);
  if (n === 1) {
    const matchIdx = text.indexOf(e.old_str);
    const focusLine = computeFocusLine(text, matchIdx, e.new_str);
    return { text: text.replace(e.old_str, () => e.new_str), focusLine };
  }
  if (n === 0) {
    const fuzzy = fuzzyReplace(text, e.old_str, e.new_str);
    if (fuzzy.found === 1) {
      const re = fuzzy.reindented ? ', new_str re-indented' : '';
      const note = `edit ${index} matched lines ${fuzzy.start}-${fuzzy.end} ignoring whitespace${re}`;
      const focusLine = fuzzy.start + Math.floor(e.new_str.split('\n').length / 2);

      // Build a verbatim-indent fallback candidate in case auto-reindentation skewed block structure.
      let altText: string | undefined;
      if (fuzzy.reindented) {
        const lines = text.split('\n');
        const beforeLines = lines.slice(0, fuzzy.start - 1);
        const afterLines = lines.slice(fuzzy.end);
        altText = [...beforeLines, e.new_str, ...afterLines].join('\n');
      }
      return { text: fuzzy.text, ...(altText ? { altText } : {}), note, focusLine };
    }
    if (fuzzy.found === 0) return { error: missText(index, path, text, e.old_str), miss: true };
    return ambiguous(index, path, `${fuzzy.lines.length} times ignoring whitespace`, fuzzy.lines);
  }
  return ambiguous(index, path, `${n} times`, linesOf(text, e.old_str));
}

function ambiguous(
  index: number,
  path: string,
  count: string,
  lines: readonly number[],
): OneResult {
  const where = lines.length ? ` (at lines ${lines.join(', ')})` : '';
  return {
    error: `edit ${index}: old_str found ${count} in ${path}${where}; it must match exactly once: add a line before or after that only the one you mean has. No changes were written.`,
  };
}

/** Apply edits in order to an in-memory copy; nothing is written unless every edit applies and passes the <5ms AST gate. */
async function applyEdits(
  path: string,
  edits: readonly z.infer<typeof editSchema>[],
  ctx: ToolContext,
): Promise<ToolOutput> {
  let abs: string;
  let text: string;
  try {
    abs = await resolvePath(ctx, path, 'write');
    text = await readFile(abs, 'utf8');
  } catch (err) {
    return fail(await openError(ctx, path, err, 'Use write_file for new files.'));
  }
  const before = text;
  let altCandidate: string | null = null;
  const notes: string[] = [];
  let primaryFocusLine = 1;

  for (const [i, e] of edits.entries()) {
    const r = applyOne(text, e, i + 1, path);
    if ('error' in r)
      return r.miss ? { content: r.error, isError: true, miss: true } : fail(r.error);
    if (i === 0) primaryFocusLine = r.focusLine;
    if (r.altText !== undefined && edits.length === 1) {
      altCandidate = r.altText;
    }
    text = r.text;
    if (r.note) notes.push(r.note);
  }

  let syntaxCheck = await preWriteSyntaxCheck(ctx, abs, text);

  // Micro-tournament: if fuzzy re-indentation failed the AST gate, test the verbatim-indent variant in memory.
  if (!syntaxCheck.ok && altCandidate !== null) {
    const altCheck = await preWriteSyntaxCheck(ctx, abs, altCandidate);
    if (altCheck.ok) {
      text = altCandidate;
      syntaxCheck = altCheck;
      notes.push('selected verbatim-indent candidate via AST gate');
    }
  }

  if (!syntaxCheck.ok) return fail(syntaxCheck.error);

  await writeFile(abs, text);
  recordEdit(ctx, abs);
  const how = notes.length ? `; ${notes.join('; ')}` : '';
  const tail = await afterEdit(ctx, abs, before);

  // Re-read post-formatter disk state so the 20-line anchored echo reflects formatted line numbers.
  const finalDiskText = await readFile(abs, 'utf8').catch(() => text);
  const echo = renderAnchoredSnippet(finalDiskText, primaryFocusLine, ECHO_SNIPPET_LINES);

  return ok(
    `edited ${path} (${edits.length} replacement${edits.length > 1 ? 's' : ''}${how})${tail}\n\n${echo}`,
  );
}

export interface CandidatePatch {
  id: string;
  edits: readonly z.infer<typeof editSchema>[];
}

export interface TournamentWinner {
  winnerId: string;
  output: ToolOutput;
  evaluated: number;
}

/**
 * Evaluate multiple candidate patch sets in memory without mutating disk.
 * Filters out patch misses and <5ms AST syntax failures, scores survivors by net-new diagnostics
 * and fuzzy drift, and writes only the winning candidate atomically.
 */
export async function runCandidateTournament(
  path: string,
  candidates: readonly CandidatePatch[],
  ctx: ToolContext,
): Promise<TournamentWinner> {
  let abs: string;
  let before: string;
  try {
    abs = await resolvePath(ctx, path, 'write');
    before = await readFile(abs, 'utf8');
  } catch (err) {
    return {
      winnerId: 'none',
      output: fail(await openError(ctx, path, err, 'Use write_file for new files.')),
      evaluated: 0,
    };
  }

  interface ScoredCandidate {
    id: string;
    text: string;
    notes: string[];
    focusLine: number;
    fuzzyCount: number;
    newDiagCount: number;
    diffSize: number;
  }

  const survivors: ScoredCandidate[] = [];
  const errors: string[] = [];

  for (const cand of candidates) {
    let current = before;
    const notes: string[] = [];
    let focusLine = 1;
    let fuzzyCount = 0;
    let failed = false;

    for (const [i, e] of cand.edits.entries()) {
      const r = applyOne(current, e, i + 1, path);
      if ('error' in r) {
        errors.push(`[${cand.id}] ${r.error}`);
        failed = true;
        break;
      }
      if (i === 0) focusLine = r.focusLine;
      current = r.text;
      if (r.note) {
        notes.push(r.note);
        fuzzyCount++;
      }
    }
    if (failed) continue;

    const syntax = await preWriteSyntaxCheck(ctx, abs, current);
    if (!syntax.ok) {
      errors.push(`[${cand.id}] ${syntax.error}`);
      continue;
    }

    const diags = await diagnoseInMemory(ctx, abs, before, current);
    survivors.push({
      id: cand.id,
      text: current,
      notes,
      focusLine,
      fuzzyCount,
      newDiagCount: diags.length,
      diffSize: Math.abs(current.length - before.length),
    });
  }

  if (survivors.length === 0) {
    return {
      winnerId: 'none',
      output: fail(
        `All ${candidates.length} edit candidates failed validation:\n${errors.join('\n---\n')}`,
      ),
      evaluated: candidates.length,
    };
  }

  // Sort by: fewest new diagnostics -> fewest fuzzy matches -> smallest diff churn
  survivors.sort(
    (a, b) =>
      a.newDiagCount - b.newDiagCount || a.fuzzyCount - b.fuzzyCount || a.diffSize - b.diffSize,
  );

  const winner: ScoredCandidate | undefined = survivors[0];
  if (!winner) {
    return {
      winnerId: 'none',
      output: fail(
        'All candidate patches were rejected by the pre-write syntax gate or failed to match.',
      ),
      evaluated: candidates.length,
    };
  }
  await writeFile(abs, winner.text);
  recordEdit(ctx, abs);
  const how = winner.notes.length ? `; ${winner.notes.join('; ')}` : '';
  const tail = await afterEdit(ctx, abs, before);
  const finalDiskText = await readFile(abs, 'utf8').catch(() => winner.text);
  const echo = renderAnchoredSnippet(finalDiskText, winner.focusLine, ECHO_SNIPPET_LINES);

  return {
    winnerId: winner.id,
    evaluated: candidates.length,
    output: ok(
      `edited ${path} via candidate "${winner.id}" (${survivors.length}/${candidates.length} passed AST gate${how})${tail}\n\n${echo}`,
    ),
  };
}

const strReplaceSchema = z.strictObject({
  path: z.string(),
  old_str: z
    .string()
    .min(1)
    .describe('Text to replace; must occur once (whitespace/indent drift is tolerated)'),
  new_str: z.string(),
});

/** Names models use for an edit's old and new text, mapped to old_str / new_str. */
const EDIT_KEY_ALIASES: Readonly<Record<string, string>> = {
  old_string: 'old_str',
  oldText: 'old_str',
  old_text: 'old_str',
  old: 'old_str',
  search: 'old_str',
  find: 'old_str',
  before: 'old_str',
  new_string: 'new_str',
  newText: 'new_str',
  new_text: 'new_str',
  new: 'new_str',
  replace: 'new_str',
  replacement: 'new_str',
  after: 'new_str',
};

export const strReplaceTool: Tool<typeof strReplaceSchema> = {
  name: 'str_replace',
  description: 'Replace one exact, unique snippet in a file. Prefer this over rewriting files.',
  schema: strReplaceSchema,
  readOnly: false,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const inner =
      Array.isArray(raw.edits) && raw.edits[0] && typeof raw.edits[0] === 'object'
        ? (raw.edits[0] as Record<string, unknown>)
        : undefined;
    const source = inner ? { ...raw, ...inner } : raw;
    return Object.fromEntries(
      Object.entries(source)
        .filter(([k]) => k !== 'edits')
        .map(([k, v]) => [EDIT_KEY_ALIASES[k] ?? k, v]),
    );
  },
  run: (input, ctx) => applyEdits(input.path, [input], ctx),
};

const multiSchema = z.strictObject({ path: z.string(), edits: z.array(editSchema).min(1).max(30) });

export const multiEditTool: Tool<typeof multiSchema> = {
  name: 'multi_edit',
  description: 'Apply several str_replace edits to one file atomically (all or nothing), in order.',
  schema: multiSchema,
  readOnly: false,
  // Models often repeat `path` inside each edit instead of once at the top: hoist it.
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const i = input as { path?: unknown; edits?: unknown };
    if (!Array.isArray(i.edits)) return input;
    const inner = i.edits.find(
      (e): e is { path: string } =>
        typeof e === 'object' && e !== null && typeof (e as { path?: unknown }).path === 'string',
    );
    return {
      ...i,
      path: i.path ?? inner?.path,
      edits: i.edits.map((e: unknown) => {
        if (typeof e !== 'object' || e === null) return e;
        return Object.fromEntries(
          Object.entries(e)
            .filter(([k]) => k !== 'path')
            .map(([k, v]) => [EDIT_KEY_ALIASES[k] ?? k, v]),
        );
      }),
    };
  },
  run: (input, ctx) => applyEdits(input.path, input.edits, ctx),
};

const writeSchema = z.strictObject({ path: z.string(), content: z.string() });

export const writeFileTool: Tool<typeof writeSchema> = {
  name: 'write_file',
  description: `Create a new file (including when renaming, moving, or splitting modules), or overwrite a file shorter than ${WRITE_MAX_LINES} lines. To modify existing files with more than ${WRITE_MAX_LINES} lines, use str_replace or multi_edit.`,
  schema: writeSchema,
  readOnly: false,
  normalize: (input) => {
    if (typeof input !== 'object' || input === null) return input;
    const raw = input as Record<string, unknown>;
    const content =
      raw.content ?? raw.contents ?? raw.text ?? raw.code ?? raw.file_text ?? raw.body;
    if (content === undefined) return input;
    const rest = { ...raw };
    delete rest.contents;
    delete rest.text;
    delete rest.code;
    delete rest.file_text;
    delete rest.body;
    return { ...rest, content };
  },
  async run(input, ctx) {
    let abs: string;
    try {
      abs = await resolvePath(ctx, input.path, 'write');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    let before = '';
    try {
      const existing = await readFile(abs, 'utf8');
      before = existing;
      if (existing.split('\n').length > WRITE_MAX_LINES) {
        return fail(
          `${input.path} has more than ${WRITE_MAX_LINES} lines; use str_replace or multi_edit instead of rewriting it`,
        );
      }
    } catch {
      // new file
    }
    const syntaxCheck = await preWriteSyntaxCheck(ctx, abs, input.content);
    if (!syntaxCheck.ok) return fail(syntaxCheck.error);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content);
    recordEdit(ctx, abs);
    const tail = await afterEdit(ctx, abs, before);
    return ok(`wrote ${input.path} (${input.content.split('\n').length} lines)${tail}`);
  },
};

/** Note a successful edit: the file joins `edited`, and every edit (repeat ones too) is counted. */
export function recordEdit(ctx: ToolContext, abs: string): void {
  const rel = ctx.jail.relative(abs);
  ctx.edited.add(rel);
  ctx.onEdit?.(rel);
}
