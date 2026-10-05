import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OmnexxPaths {
  /** Run state, worktrees and logs. `OMNEXX_HOME`, default `~/.omnexx`. */
  home: string;
  /** User config and credentials. `OMNEXX_CONFIG_HOME`, default `~/.config/omnexx`. */
  configHome: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OmnexxPaths {
  const xdg = env.XDG_CONFIG_HOME;
  return {
    home: env.OMNEXX_HOME ?? join(homedir(), '.omnexx'),
    configHome: env.OMNEXX_CONFIG_HOME ?? join(xdg ?? join(homedir(), '.config'), 'omnexx'),
  };
}

export const runsDir = (p: OmnexxPaths): string => join(p.home, 'runs');
export const runDir = (p: OmnexxPaths, runId: string): string => join(p.home, 'runs', runId);
export const worktreesDir = (p: OmnexxPaths): string => join(p.home, 'worktrees');
export const userConfigFile = (p: OmnexxPaths): string => join(p.configHome, 'config.toml');
export const credentialsDir = (p: OmnexxPaths): string => join(p.configHome, 'credentials');
