import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SECTION_IDS,
  SECTION_INFO,
  SECTION_MODES,
  type SectionId,
  type SectionMode,
} from '../agent/sections.js';
import { loadConfig } from '../config/load.js';
import { readSectionModes, sectionsFile } from '../config/sections-file.js';
import { resolvePaths, type OmnexxPaths } from '../core/paths.js';
import { repoMemoryFile } from '../core/repo-memory.js';
import { listRunIds, RunStore } from '../core/run-store.js';
import { estimateTokens } from '../core/tokens.js';
import { UsageError } from '../errors.js';
import { repoRoot } from '../git/repo.js';
import type { CliIO } from './io.js';

/**
 * The Context explorer's data: every file that feeds the agent's context in this workspace, its
 * size in tokens, whether it can be edited, and (for sections) how it reaches the model. Section
 * modes are saved to context-sections.json and loaded as a config layer.
 */

export interface ContextFile {
  id: string;
  label: string;
  about: string;
  path: string;
  tokens: number;
  exists: boolean;
  /** Edits are read on the next cycle; generated files are views. */
  editable: boolean;
  /** For context sections: how it reaches the model. */
  section?: SectionId;
  mode?: SectionMode;
}

export async function setSectionMode(io: CliIO, id: string, mode: string): Promise<void> {
  if (!(SECTION_IDS as readonly string[]).includes(id)) throw new UsageError(`no section "${id}"`);
  if (!(SECTION_MODES as readonly string[]).includes(mode))
    throw new UsageError(`mode is one of ${SECTION_MODES.join(', ')}`);
  const p = resolvePaths(io.env);
  const modes = { ...(await readSectionModes(p)), [id]: mode };
  await mkdir(dirname(sectionsFile(p)), { recursive: true });
  await writeFile(sectionsFile(p), `${JSON.stringify(modes, null, 2)}\n`);
}

async function sizeOf(path: string): Promise<{ exists: boolean; tokens: number }> {
  try {
    if (!(await stat(path)).isFile()) return { exists: false, tokens: 0 };
    return { exists: true, tokens: estimateTokens(await readFile(path, 'utf8')) };
  } catch {
    return { exists: false, tokens: 0 };
  }
}

/** The newest run started from this repository, if any. */
async function latestRun(paths: OmnexxPaths, root: string): Promise<RunStore | undefined> {
  for (const id of [...(await listRunIds(paths))].reverse()) {
    const store = new RunStore(paths, id);
    const s = await store.readState().catch(() => undefined);
    if (s?.repoRoot === root) return store;
  }
  return undefined;
}

export async function contextFiles(
  io: CliIO,
): Promise<{ runId: string | null; files: ContextFile[] }> {
  const paths = resolvePaths(io.env);
  const root = await repoRoot(io.cwd).catch(() => io.cwd);
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env });
  const modes = config.context.sections;
  const run = await latestRun(paths, root);
  const state = run ? await run.readState().catch(() => undefined) : undefined;
  const memoryDir = dirname(await repoMemoryFile({ home: paths.home }, root));

  const entries: Omit<ContextFile, 'tokens' | 'exists'>[] = [];
  const section = (id: SectionId, path: string, editable: boolean): void => {
    const info = SECTION_INFO[id];
    entries.push({
      id,
      label: info.label,
      about: info.about,
      path,
      editable,
      section: id,
      mode: modes[id],
    });
  };
  if (run) {
    if (state?.taskId) section('role', run.file(join('roles', `${state.taskId}.md`)), true);
    section('codemap', run.file('codemap.md'), false);
    section('intent', run.file('intent.md'), true);
    section('lessons', run.file('notes.md'), false);
    section('progress', run.file('progress.md'), false);
    entries.push({
      id: 'goal',
      label: 'Goal',
      about: 'what this run is for',
      path: run.file('goal.md'),
      editable: true,
    });
  }
  entries.push(
    {
      id: 'repo-role',
      label: 'Repo role note',
      about: 'added to every role card in this repo',
      path: join(root, '.omnexx', 'role.md'),
      editable: true,
    },
    {
      id: 'general-notes',
      label: 'General notes',
      about: 'what the agent keeps about this repo across runs',
      path: join(memoryDir, 'scopes', 'general.md'),
      editable: true,
    },
    {
      id: 'repo-notes',
      label: 'Repo notes',
      about: 'architecture and where things live, across runs',
      path: join(memoryDir, 'scopes', 'repo.md'),
      editable: true,
    },
  );
  const files = await Promise.all(entries.map(async (e) => ({ ...e, ...(await sizeOf(e.path)) })));
  return { runId: run?.runId ?? null, files };
}
