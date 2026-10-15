import { posix } from 'node:path';
import { parseFrontmatter } from '../instructions/frontmatter.js';

/**
 * Reading skills straight from GitHub, without cloning: the repo's file tree (one API call)
 * finds every `SKILL.md` folder and its files, raw.githubusercontent.com serves the contents.
 * A `.claude-plugin/marketplace.json` (the Claude Code plugin marketplace format) can point at
 * more repos, which are read the same way. Nothing fetched is ever run.
 */

/** The parts of `fetch` used here, so tests can pass a fake. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface MarketFile {
  path: string;
  size: number;
}

/** One skill found in a marketplace repo. */
export interface MarketSkill {
  /** `owner/repo:path/to/skill` (`.` for a skill at the repo root). */
  id: string;
  name: string;
  description: string;
  repo: string;
  path: string;
  /** Git tree sha of the folder: changes whenever any file in it does. */
  sha: string;
  /** Files relative to the skill folder, shown before install. */
  files: MarketFile[];
  url: string;
}

/** Limits that keep a hostile or huge repo from flooding the catalog or the disk. */
export const MAX_SKILLS_PER_REPO = 200;
export const MAX_FILES_PER_SKILL = 100;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_LINKED_REPOS = 20;

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo`, `github.com/owner/repo`, or a GitHub https/git URL. */
export function parseRepoRef(input: string): RepoRef {
  const s = input
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const [owner, repo, ...rest] = s.split('/');
  const extra = rest.length > 0 && rest[0] !== 'tree';
  if (!owner || !repo || extra || !NAME_RE.test(owner) || !NAME_RE.test(repo) || s.includes(':'))
    throw new Error(`"${input}" is not a GitHub repo (use owner/repo or a github.com URL)`);
  return { owner, repo };
}

export const repoName = (r: RepoRef): string => `${r.owner}/${r.repo}`;

/** A path inside a skill that is safe to write: relative, no `..`, no hidden git data. */
export function safeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  const parts = p.split('/');
  return parts.every((x) => x !== '' && x !== '.' && x !== '..' && x !== '.git');
}

function headers(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'omnexx',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function getText(fetchFn: FetchLike, url: string, env: NodeJS.ProcessEnv): Promise<string> {
  const res = await fetchFn(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`GET ${url} failed (${String(res.status)})`);
  return res.text();
}

export function rawUrl(r: RepoRef, path: string): string {
  return `https://raw.githubusercontent.com/${repoName(r)}/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function fetchRaw(
  fetchFn: FetchLike,
  r: RepoRef,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return getText(fetchFn, rawUrl(r, path), env);
}

/** A file's bytes as stored (skills may carry images or other binary files). */
export async function fetchRawBytes(
  fetchFn: FetchLike,
  r: RepoRef,
  path: string,
  env: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  const url = rawUrl(r, path);
  const res = await fetchFn(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`GET ${url} failed (${String(res.status)})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES)
    throw new Error(`${path} is over ${String(MAX_FILE_BYTES)} bytes`);
  return bytes;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

async function fetchTree(
  fetchFn: FetchLike,
  r: RepoRef,
  env: NodeJS.ProcessEnv,
): Promise<{ sha: string; entries: TreeEntry[] }> {
  const url = `https://api.github.com/repos/${repoName(r)}/git/trees/HEAD?recursive=1`;
  const data = JSON.parse(await getText(fetchFn, url, env)) as {
    sha?: unknown;
    tree?: unknown;
  };
  if (!Array.isArray(data.tree)) throw new Error(`unexpected tree for ${repoName(r)}`);
  const entries = (data.tree as Partial<TreeEntry>[]).filter(
    (e): e is TreeEntry =>
      typeof e.path === 'string' && typeof e.type === 'string' && typeof e.sha === 'string',
  );
  return { sha: typeof data.sha === 'string' ? data.sha : '', entries };
}

function skillFiles(entries: readonly TreeEntry[], dir: string): MarketFile[] {
  const prefix = dir === '.' ? '' : `${dir}/`;
  return entries
    .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }))
    .filter((f) => safeRelativePath(f.path))
    .slice(0, MAX_FILES_PER_SKILL);
}

/** Every skill in one repo, with name and description read from its SKILL.md. */
export async function listRepoSkills(
  fetchFn: FetchLike,
  r: RepoRef,
  env: NodeJS.ProcessEnv,
): Promise<MarketSkill[]> {
  const tree = await fetchTree(fetchFn, r, env);
  const dirs = tree.entries
    .filter((e) => e.type === 'blob' && posix.basename(e.path) === 'SKILL.md')
    .map((e) => posix.dirname(e.path))
    .slice(0, MAX_SKILLS_PER_REPO);
  const shaOf = (dir: string): string =>
    dir === '.'
      ? tree.sha
      : (tree.entries.find((e) => e.type === 'tree' && e.path === dir)?.sha ?? '');
  const skills = await Promise.all(
    dirs.map(async (dir): Promise<MarketSkill | undefined> => {
      const md = await fetchRaw(
        fetchFn,
        r,
        dir === '.' ? 'SKILL.md' : `${dir}/SKILL.md`,
        env,
      ).catch(() => undefined);
      if (md === undefined) return undefined;
      const { data } = parseFrontmatter(md);
      const folder = dir === '.' ? r.repo : posix.basename(dir);
      return {
        id: `${repoName(r)}:${dir}`,
        name: data.name?.trim() ? data.name.trim() : folder,
        description: (data.description ?? '').trim(),
        repo: repoName(r),
        path: dir,
        sha: shaOf(dir),
        files: skillFiles(tree.entries, dir),
        url: `https://github.com/${repoName(r)}/tree/HEAD/${dir === '.' ? '' : dir}`,
      };
    }),
  );
  return skills.filter((s): s is MarketSkill => s !== undefined);
}

/**
 * Repos a `.claude-plugin/marketplace.json` lists as plugin sources (`{source: "github", repo}`
 * or a github.com `url`). Plugins inside the same repo need nothing extra: the tree scan finds them.
 */
export async function marketplaceRepos(
  fetchFn: FetchLike,
  r: RepoRef,
  env: NodeJS.ProcessEnv,
): Promise<RepoRef[]> {
  const text = await fetchRaw(fetchFn, r, '.claude-plugin/marketplace.json', env).catch(
    () => undefined,
  );
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const plugins = (data as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];
  const refs: RepoRef[] = [];
  for (const p of plugins as { source?: unknown }[]) {
    const src: unknown = p.source;
    const obj =
      typeof src === 'object' && src !== null
        ? (src as { repo?: unknown; url?: unknown })
        : undefined;
    const target = obj
      ? typeof obj.repo === 'string'
        ? obj.repo
        : typeof obj.url === 'string'
          ? obj.url
          : undefined
      : undefined;
    if (!target) continue;
    try {
      const ref = parseRepoRef(target);
      if (repoName(ref) !== repoName(r) && !refs.some((x) => repoName(x) === repoName(ref)))
        refs.push(ref);
    } catch {
      // Not on GitHub: it can still be added by hand with `omnexx skills add <git-url>`.
    }
  }
  return refs.slice(0, MAX_LINKED_REPOS);
}
