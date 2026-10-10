import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { git } from '../git/git.js';
import type { InstallPlan } from './registry.js';
import { writeServerSecrets } from './secrets.js';
import { setTable, type TomlValue } from './toml-edit.js';

/**
 * Installing integrations, shared by the CLI (`omnexx mcp add`, `omnexx skills add`) and the
 * agent's `integrations_install` tool so both behave exactly the same.
 */

export async function readConfigText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** Write one `[mcp.servers.<name>]` table, leaving the rest of the file (and its comments) alone. */
export async function writeServer(
  file: string,
  name: string,
  server: Record<string, TomlValue | undefined>,
): Promise<void> {
  const next = setTable(await readConfigText(file), ['mcp', 'servers', name], server);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
}

/** The TOML keys for a server; empty defaults are left out to keep the table short. */
export function tomlFor(s: {
  command?: string | undefined;
  args?: readonly string[];
  url?: string | undefined;
  env?: Readonly<Record<string, string>> | readonly string[];
  headers_env?: Readonly<Record<string, string>>;
  oauth?: boolean | undefined;
}): Record<string, TomlValue | undefined> {
  const env = s.env && (Array.isArray(s.env) ? s.env.length : Object.keys(s.env).length);
  const headers = s.headers_env && Object.keys(s.headers_env).length;
  return {
    command: s.command,
    args: s.command && s.args?.length ? s.args : undefined,
    url: s.url,
    env: env ? s.env : undefined,
    headers_env: headers ? s.headers_env : undefined,
    oauth: s.oauth ? true : undefined,
  };
}

/** Install a registry server: its config table, plus the settings given for it as secrets. */
export async function installRegistryServer(
  configFile: string,
  configHome: string,
  plan: InstallPlan,
  values: Record<string, string>,
): Promise<void> {
  await writeServer(configFile, plan.name, tomlFor(plan.config));
  await writeServerSecrets(configHome, plan.name, values);
}

export const isGitUrl = (s: string) =>
  /^(https?|ssh|file):\/\/|^git@/.test(s) || s.endsWith('.git');

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Skill folders under `root`: root itself when it holds a SKILL.md, else each child (or `skills/*`) that does. */
export async function findSkillFolders(root: string): Promise<string[]> {
  if (await exists(join(root, 'SKILL.md'))) return [root];
  const out: string[] = [];
  for (const base of [root, join(root, 'skills')]) {
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of entries)
      if (e.isDirectory() && (await exists(join(base, e.name, 'SKILL.md'))))
        out.push(join(base, e.name));
  }
  return out;
}

/**
 * Copy the skills in `source` (a skill folder, a folder of them, or a git URL) into `userDir`.
 * Returns the names added and the ones skipped because they were already there.
 */
export async function addSkills(
  source: string,
  userDir: string,
  force = false,
): Promise<{ added: string[]; skipped: string[]; found: number }> {
  let tmp: string | undefined;
  try {
    let root = source;
    if (isGitUrl(source)) {
      tmp = await mkdtemp(join(tmpdir(), 'omnexx-skill-'));
      await git(tmp, ['clone', '--depth', '1', '--', source, 'repo']);
      root = join(tmp, 'repo');
    }
    const folders = await findSkillFolders(root);
    const added: string[] = [];
    const skipped: string[] = [];
    for (const f of folders) {
      const dest = join(userDir, basename(f));
      if ((await exists(dest)) && !force) {
        skipped.push(basename(f));
        continue;
      }
      await rm(dest, { recursive: true, force: true });
      await cp(f, dest, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
      added.push(basename(f));
    }
    return { added, skipped, found: folders.length };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
