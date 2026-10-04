import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { fail, ok, type Tool } from './types.js';

export interface Symbol {
  line: number;
  kind: string;
  name: string;
}

const RULES: readonly [RegExp, string][] = [
  [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const'],
  [
    /^\s*(?:public |private |protected |static |async |readonly )*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/,
    'method',
  ],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
  [/^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, 'class'],
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'],
  [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type'],
  [/^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/, 'item'],
];
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
]);

/** Deterministic, dependency-free symbol extraction. Good enough to navigate, not a parser. */
export function extractSymbols(text: string): Symbol[] {
  const out: Symbol[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [re, kind] of RULES) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name && !KEYWORDS.has(name)) {
        out.push({ line: i + 1, kind, name });
        break;
      }
    }
  });
  return out;
}

export function renderOutline(symbols: readonly Symbol[], totalLines: number): string {
  if (!symbols.length) return `(no symbols found; ${totalLines} lines)`;
  return [
    `${totalLines} lines`,
    ...symbols.map((s) => `${String(s.line).padStart(5)}  ${s.kind} ${s.name}`),
  ].join('\n');
}

const schema = z.strictObject({ path: z.string().describe('File path relative to the repo root') });

export const outlineTool: Tool<typeof schema> = {
  name: 'outline',
  description:
    'List the symbols (functions, classes, types, exports) of a file with their line numbers. Use before reading large files.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    try {
      const abs = ctx.jail.resolve(input.path, 'read');
      const text = await readFile(abs, 'utf8');
      return ok(renderOutline(extractSymbols(text), text.split('\n').length));
    } catch (err) {
      return fail(
        err instanceof OmnexxError
          ? err.message
          : `cannot outline ${input.path}: ${(err as Error).message}`,
      );
    }
  },
};
