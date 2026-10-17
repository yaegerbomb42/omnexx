import { z } from 'zod';
import { CHARS_PER_TOKEN } from '../core/tokens.js';
import { OmnexxError } from '../errors.js';
import { onHost } from './post-edit.js';
import { readSymbolHeuristic } from './symbol-heuristic.js';
import { readSymbolTs } from './symbol-ts.js';
import type {
  SourceBlock,
  SymbolFound,
  SymbolQuery,
  SymbolRef,
  SymbolResult,
} from './symbol-types.js';
import { fail, ok, type Tool, type ToolContext } from './types.js';

/** Whole answer budget: about 2.5k tokens. */
export const MAX_CHARS = 2_500 * CHARS_PER_TOKEN;
/** A signature type longer than this shows only its first lines. */
const MAX_TYPE_LINES = 25;
/** The language service gets this long; a cold start that takes longer falls back. */
const TS_TIMEOUT_MS = 8_000;

const schema = z.strictObject({
  symbol: z.string().min(1).describe('Function, method, class, interface or type name'),
  path: z.string().optional().describe('Picks one of several same-name definitions'),
  depth: z
    .union([z.literal(0), z.literal(1)])
    .optional()
    .describe('1 adds caller and callee signatures'),
});

const refLine = (r: SymbolRef): string => `  ${r.file}:${String(r.line)}  ${r.text}`;

function renderBlock(b: SourceBlock, maxLines = b.lines.length): string {
  const shown = b.lines.slice(0, maxLines);
  const rows = shown.map((l, i) => `${String(b.start + i).padStart(5)} ${l}`);
  if (shown.length < b.lines.length) {
    const from = b.start + shown.length;
    rows.push(
      `  … lines ${String(from)}-${String(b.end)} not shown (read ${b.file} start ${String(from)})`,
    );
  }
  return [`${b.file}:${String(b.start)}-${String(b.end)}`, ...rows].join('\n');
}

function refSection(title: string, refs: readonly SymbolRef[], total: number): string[] {
  if (!total) return [`${title}: none found`];
  const more = total > refs.length ? `, showing ${String(refs.length)}` : '';
  return [`${title} (${String(total)}${more}):`, ...refs.map(refLine)];
}

/** The definition, its signature types and (depth 1) callers and callees, within MAX_CHARS. */
export function renderFound(r: SymbolFound, depth: 0 | 1): string {
  const tail: string[] = [];
  if (r.types.length) {
    tail.push('Types in its signature:', ...r.types.map((t) => renderBlock(t, MAX_TYPE_LINES)));
  }
  if (depth) {
    tail.push(...refSection('Callers', r.callers, r.callerTotal));
    tail.push(...refSection('Callees', r.callees, r.calleeTotal));
  }
  const tailText = tail.join('\n');
  const full = renderBlock(r.def);
  const budget = MAX_CHARS - tailText.length;
  if (full.length <= budget) return [full, tailText].filter(Boolean).join('\n');
  // Too long: keep as many definition lines as fit, and say how to see the rest.
  let lines = r.def.lines.length;
  let def = full;
  while (lines > 1 && def.length > budget) {
    lines = Math.floor(lines * 0.8);
    def = renderBlock(r.def, lines);
  }
  const note = '(output capped at ~2.5k tokens; read the remaining lines, or narrow with path)';
  return [def, tailText, note]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_CHARS + note.length);
}

export function renderResult(q: SymbolQuery, r: SymbolResult): string {
  if (r.kind === 'found') return renderFound(r, q.depth);
  if (r.kind === 'ambiguous') {
    return [
      `${String(r.candidates.length)} definitions named ${q.symbol}; call again with path set to one:`,
      ...r.candidates.slice(0, 20).map(refLine),
    ].join('\n');
  }
  const near = r.suggestions.length ? ` Close names: ${r.suggestions.join(', ')}.` : '';
  const where = q.path ? ` in ${q.path}` : '';
  return `no definition of ${q.symbol}${where}.${near}`;
}

/** Language service first (TS/JS repos with their own typescript, on the host), else heuristic. */
export async function lookupSymbol(
  ctx: ToolContext,
  q: SymbolQuery,
  timeoutMs = TS_TIMEOUT_MS,
): Promise<SymbolResult> {
  const root = ctx.jail.resolve('.', 'read');
  const viaTs = onHost(ctx) ? await readSymbolTs(root, q, timeoutMs) : null;
  if (viaTs && viaTs.kind !== 'missing') return viaTs;
  return readSymbolHeuristic(root, q);
}

export const readSymbolTool: Tool<typeof schema> = {
  name: 'read_symbol',
  description:
    'Read a symbol by name: its definition with line numbers and the types in its signature.',
  schema,
  readOnly: true,
  concurrent: true,
  async run(input, ctx) {
    if (input.path) {
      try {
        ctx.jail.resolve(input.path, 'read');
      } catch (err) {
        return fail(err instanceof OmnexxError ? err.message : String(err));
      }
    }
    const q: SymbolQuery = {
      symbol: input.symbol.trim(),
      depth: input.depth ?? 0,
      ...(input.path ? { path: input.path.replace(/^\.\//, '').replace(/\/$/, '') } : {}),
    };
    const r = await lookupSymbol(ctx, q);
    const text = ctx.redactor.text(renderResult(q, r));
    return r.kind === 'missing' ? fail(text) : ok(text);
  },
};
