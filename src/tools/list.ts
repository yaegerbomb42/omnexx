import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { OmnexxError } from '../errors.js';
import { isSecretPath } from '../security/paths.js';
import { SKIP_DIRS } from './search.js';
import { fail, ok, type Tool } from './types.js';

export const MAX_ENTRIES = 400;

const schema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe('Directory to list, relative to the repo root (default: the root)'),
  depth: z.number().int().min(1).max(8).optional().describe('How many levels down (default 3)'),
});

/** Files and folders under `root`, folders ending in "/", dependency and build folders left out. */
export async function listTree(root: string, base: string, depth: number): Promise<string> {
  const out: string[] = [];
  let more = 0;
  const walk = async (dir: string, level: number): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const e of entries) {
      if (e.name === '.git' || (e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
      const rel = relative(base, join(dir, e.name));
      if (isSecretPath(rel)) continue;
      if (out.length >= MAX_ENTRIES) {
        more++;
        continue;
      }
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory() && level < depth) await walk(join(dir, e.name), level + 1);
    }
  };
  await walk(root, 1);
  if (!out.length) return '(empty)';
  return more ? `${out.join('\n')}\n… ${String(more)} more; list a subfolder` : out.join('\n');
}

export const listTool: Tool<typeof schema> = {
  name: 'list',
  description:
    'List files and folders as a tree (folders end in "/"; dependency and build folders are left out). Use it to find your way around before reading.',
  schema,
  readOnly: true,
  async run(input, ctx) {
    let dir: string;
    try {
      dir = ctx.jail.resolve(input.path ?? '.', 'read');
    } catch (err) {
      return fail(err instanceof OmnexxError ? err.message : String(err));
    }
    try {
      return ok(await listTree(dir, ctx.jail.resolve('.', 'read'), input.depth ?? 3));
    } catch (err) {
      return fail(`cannot list ${input.path ?? '.'}: ${(err as Error).message}`);
    }
  },
};
