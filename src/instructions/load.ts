import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CHARS_PER_TOKEN } from '../core/tokens.js';
import { parseFrontmatter } from './frontmatter.js';
import { readTextIfExists } from './read.js';

/** Total instruction budget across every file, in estimated tokens. */
export const INSTRUCTIONS_MAX_TOKENS = 8_000;

const TRUNCATE_MARKER = '… (truncated)';

export interface InstructionFile {
  /** Repo-relative POSIX path, used as the section header (and in the truncation note). */
  path: string;
  /** Raw file text; rendering trims it. Cut by the budget before it gets here. */
  text: string;
}

export interface LoadedInstructions {
  /**
   * Render order, which is also the precedence order: the first file survives longest when the
   * 8k-token budget cuts. Root files in the documented order, then nested files shallow → deep.
   */
  files: InstructionFile[];
  /** Files dropped or cut to fit the budget, lowest precedence first. */
  truncated: string[];
}

/** Root files in precedence order; nested files are appended after these. */
const ROOT_FILES = ['OMNEXX.md', 'AGENTS.md', 'CLAUDE.md'] as const;
const NESTED_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

let last: LoadedInstructions | undefined;

/** Directories between the repo root and cwdInRepo, shallow first; [] when cwd is outside. */
function nestedDirs(repoRoot: string, cwdInRepo: string): string[] {
  const rel = relative(repoRoot, cwdInRepo);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];
  const dirs: string[] = [];
  let acc = '';
  for (const part of rel.split(sep).filter(Boolean)) {
    acc = acc === '' ? part : join(acc, part);
    dirs.push(acc);
  }
  return dirs;
}

function compose(files: readonly InstructionFile[], truncated: readonly string[]): string {
  if (files.length === 0) return '';
  const parts = ['# Project instructions', ''];
  for (const f of files) parts.push(`### ${f.path}`, '', f.text.trim(), '');
  let out = parts.join('\n').trimEnd();
  if (truncated.length > 0) {
    out += `\n\n> Note: project instructions were truncated to fit the ${INSTRUCTIONS_MAX_TOKENS}-token budget; cut: ${truncated.join(', ')}`;
  }
  return out;
}

/**
 * Read every project instruction file relevant to cwdInRepo: the root files in the documented
 * precedence order, `.cursor/rules/*.mdc` (frontmatter stripped, sorted by name), and nested
 * AGENTS.md/CLAUDE.md in the parent directories of cwdInRepo. The combined render is capped at
 * 8k tokens, cutting the lowest precedence (last rendered) files first and noting every cut.
 * The same repo and cwd always produce byte-identical output, so the prompt prefix stays stable.
 */
export async function loadInstructions(
  repoRoot: string,
  cwdInRepo: string,
): Promise<LoadedInstructions> {
  const files: InstructionFile[] = [];
  const push = async (path: string, file: string, frontmatter = false): Promise<void> => {
    const raw = await readTextIfExists(file);
    if (raw === undefined) return;
    const text = frontmatter ? parseFrontmatter(raw).body : raw;
    if (text.trim()) files.push({ path, text });
  };
  for (const name of ROOT_FILES) await push(name, join(repoRoot, name));
  const rulesDir = join(repoRoot, '.cursor', 'rules');
  const rules = await readdir(rulesDir).catch(() => []);
  for (const name of [...rules]
    .filter((n) => n.endsWith('.mdc'))
    .sort((a, b) => a.localeCompare(b))) {
    await push(`.cursor/rules/${name}`, join(rulesDir, name), true);
  }
  await push(
    '.github/copilot-instructions.md',
    join(repoRoot, '.github', 'copilot-instructions.md'),
  );
  for (const dir of nestedDirs(repoRoot, cwdInRepo)) {
    const posixDir = dir.split(sep).join('/');
    for (const name of NESTED_FILES) await push(`${posixDir}/${name}`, join(repoRoot, dir, name));
  }

  const budget = INSTRUCTIONS_MAX_TOKENS * CHARS_PER_TOKEN;
  const truncated: string[] = [];
  let out = compose(files, truncated);
  while (out.length > budget && files.length > 1) {
    const dropped = files.pop();
    if (dropped) truncated.push(dropped.path);
    out = compose(files, truncated);
  }
  if (out.length > budget) {
    // One file bigger than the whole budget: keep its head instead of dropping it.
    const only = files[0];
    if (only) {
      truncated.push(only.path);
      let text = only.text;
      for (;;) {
        only.text = text;
        out = compose(files, truncated);
        if (out.length <= budget) break;
        const keep = text.length - (out.length - budget) - TRUNCATE_MARKER.length - 1;
        const next = `${text.slice(0, Math.max(0, keep))}\n${TRUNCATE_MARKER}`;
        if (next === text) break;
        text = next;
      }
    }
  }
  const loaded: LoadedInstructions = { files, truncated };
  last = loaded;
  return loaded;
}

/**
 * Render the instructions for the prompt prefix. Zero-arg form uses the result of the last
 * `loadInstructions` call (prompts.ts wires this); pass an explicit value in tests. Returns ''
 * when nothing was loaded, so callers can skip the block entirely.
 */
export function renderInstructions(
  loaded: LoadedInstructions = last ?? { files: [], truncated: [] },
): string {
  return compose(loaded.files, loaded.truncated);
}
