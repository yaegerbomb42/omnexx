/**
 * Parsing a `path:line:column` reference from a reply. No VS Code here, so the root suite can
 * test it; `chatView.ts` turns the result into an editor selection.
 */

export interface Location {
  /** The path exactly as written, with any line/column suffix removed. */
  file: string;
  /** 1-based line, as written in the text. */
  line?: number;
  /** 1-based column, as written in the text. */
  column?: number;
}

/**
 * `src/a.ts` → file only; `src/a.ts:12` → line 12; `src/a.ts:12:5` → line 12, column 5.
 *
 * The column matters: `render.ts` deliberately links `path:line:col` (its PATH pattern accepts
 * both), so a `path:line:col` reference that only understands the line used to open a file
 * literally named `src/a.ts:12`.
 */
export function parseLocation(spec: string): Location {
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(spec);
  const file = m?.[1] ?? '';
  // `:12` alone is not a path; treat the whole spec as the name.
  if (!file) return { file: spec };
  const line = m?.[2] ? Number(m[2]) : undefined;
  const column = m?.[3] ? Number(m[3]) : undefined;
  if (line === undefined) return { file };
  return column === undefined ? { file, line } : { file, line, column };
}
