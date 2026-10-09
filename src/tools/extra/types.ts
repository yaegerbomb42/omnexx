import type { OmnexxConfig } from '../../config/schema.js';
import type { Tool } from '../types.js';

/**
 * A workstream's tools. `load` runs once per cycle and may return nothing (a backend is missing,
 * the feature is off in config). Tools from every source are sorted by name so the cached prompt
 * prefix stays byte-stable no matter which sources are present.
 */
export interface ToolSource {
  load(config: OmnexxConfig, where?: ToolWhere): readonly Tool[] | Promise<readonly Tool[]>;
}

/** Where the tools will run: the repo (or worktree) and the environment of that run or chat. */
export interface ToolWhere {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}
