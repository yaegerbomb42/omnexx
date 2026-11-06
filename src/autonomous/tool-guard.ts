import { execa } from 'execa';
import { basename, resolve, sep } from 'node:path';
import { OmnexxError } from '../errors.js';
import { checkCommand, type PolicyContext } from '../security/command-policy.js';
import { scrubEnv } from '../security/env-scrub.js';
import { isInside } from '../security/paths.js';

/**
 * Safety guard for the 24/7 autonomous daemon: the tool boundary between the agent and the
 * host. It composes the existing equivalents instead of duplicating them —
 * `src/security/command-policy.ts` (shell firewall) and `src/security/env-scrub.ts`
 * (env scrubbing) — and adds the daemon's immutable path denylist, its extra shell rules,
 * and the dependency supply-chain checks.
 *
 * Every violation throws {@link SecurityGuardrailError}; the daemon aborts the task to
 * QUARANTINE on it. Nothing here is configurable at runtime: the denylist is a module
 * constant, so a compromised task cannot talk the guard out of its rules.
 */

export class SecurityGuardrailError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('security-guardrail', message, hint);
  }
}

/** Paths the daemon agent may never read or write, matched against repo-relative paths. */
export const DENYLIST: readonly string[] = [
  'omnexx.toml',
  '.omnexx/**',
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  'Dockerfile*',
  'scripts/release*',
  '.npmrc',
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*credentials*',
  '.git/config',
  '.git/hooks/**',
];

/** Lockfiles: read-only unless the change comes from the dependency updater. */
export const LOCKFILES: readonly string[] = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
];

function matchGlob(pattern: string, path: string): boolean {
  // `**` crosses segments; `*` stays inside one segment.
  const re = new RegExp(
    `^${pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );
  return re.test(path);
}

function isDeniedPath(relPath: string): string | undefined {
  const normalized = relPath.split(sep).join('/');
  const base = basename(normalized);
  for (const pattern of DENYLIST) {
    if (pattern.includes('/')) {
      if (matchGlob(pattern, normalized)) return pattern;
    } else if (matchGlob(pattern, base) || matchGlob(pattern, normalized)) {
      return pattern;
    }
  }
  return undefined;
}

export type PathMode = 'read' | 'write';

export interface GuardPathOptions {
  /** Which collector produced the change; only `dependency_update` may write lockfiles. */
  sourceCollector?: string;
}

/**
 * Enforce the denylist (and the lockfile rule) for one repo-relative path.
 * Throws {@link SecurityGuardrailError} on violation.
 */
export function assertPathAllowed(
  relPath: string,
  mode: PathMode,
  opts: GuardPathOptions = {},
): void {
  const denied = isDeniedPath(relPath);
  if (denied) {
    throw new SecurityGuardrailError(
      `${mode} of ${relPath} is denied (matches denylist rule ${denied})`,
      'the daemon may never touch config, credentials, CI, or its own state files',
    );
  }
  if (
    mode === 'write' &&
    LOCKFILES.includes(basename(relPath)) &&
    opts.sourceCollector !== 'dependency_update'
  ) {
    throw new SecurityGuardrailError(
      `write of lockfile ${relPath} is denied outside dependency_update`,
      'only the dependency updater may change lockfiles',
    );
  }
}

/** True when the path passes the denylist (and, for writes, the lockfile rule). */
export function isPathAllowed(
  relPath: string,
  mode: PathMode,
  opts: GuardPathOptions = {},
): boolean {
  try {
    assertPathAllowed(relPath, mode, opts);
    return true;
  } catch {
    return false;
  }
}

/** Extra daemon shell rules, on top of the existing command policy. */
const DAEMON_DENY: readonly { pattern: RegExp; rule: string; reason: string }[] = [
  {
    pattern: /\bgit\s+push\b.*--force\b/,
    rule: 'git-push-force',
    reason: 'git push --force is never allowed; the shipping controller pushes fast-forward only',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    rule: 'git-reset-hard',
    reason:
      'git reset --hard outside a worktree would destroy user state; use the worktree manager',
  },
  {
    pattern: /\bgh\s+(repo\s+delete|release)\b/,
    rule: 'gh-destructive',
    reason: 'gh repo delete / gh release are destructive and never part of a task',
  },
  {
    pattern: /\bnpm\s+publish\b/,
    rule: 'npm-publish',
    reason: 'npm publish is never part of a task; releases go through scripts/release* (denied)',
  },
  {
    pattern: /\b(curl|wget)\b/,
    rule: 'network-fetch',
    reason: 'curl/wget are not allowed; the harness fetches what a task needs',
  },
  {
    pattern: /\bchmod\b[^|;&]*\+s\b/,
    rule: 'chmod-setuid',
    reason: 'chmod +s (setuid/setgid) is never allowed',
  },
  {
    pattern: /(^|[\s'"])\.\.([/\\]|$)/,
    rule: 'path-traversal',
    reason: '.. traversal outside the worktree is not allowed',
  },
];

export interface DaemonCommandVerdict {
  allowed: boolean;
  rule?: string | undefined;
  reason?: string | undefined;
}

/**
 * Shell firewall for the daemon's bash tool: the existing command policy first
 * (it already denies sudo/ssh/nc, `gh`, `npm publish`, git writes, and writes outside the
 * worktree), then the daemon's extra rules. The `..` rule is scoped to arguments that
 * resolve outside `ctx.root`; a `..` that stays inside the worktree is fine.
 */
export function checkDaemonCommand(command: string, ctx: PolicyContext): DaemonCommandVerdict {
  const base = checkCommand(command, ctx);
  if (!base.allowed) return { allowed: false, rule: base.rule, reason: base.reason };
  for (const { pattern, rule, reason } of DAEMON_DENY) {
    if (!pattern.test(command)) continue;
    if (rule === 'path-traversal') {
      // Only a traversal that actually escapes the worktree is a violation:
      // resolve every `..`-bearing token against the root and check containment.
      const outside = command
        .split(/[\s'";|&]+/)
        .filter((t) => t.includes('..'))
        .some((t) => {
          const cleaned = t.replace(/^['"]|['"]$/g, '');
          return !isInside(ctx.root, resolve(ctx.root, cleaned));
        });
      if (!outside) continue;
    }
    return { allowed: false, rule, reason };
  }
  return { allowed: true };
}

/** Like {@link checkDaemonCommand} but throws {@link SecurityGuardrailError} on denial. */
export function assertDaemonCommand(command: string, ctx: PolicyContext): void {
  const verdict = checkDaemonCommand(command, ctx);
  if (!verdict.allowed) {
    throw new SecurityGuardrailError(
      `command denied [${verdict.rule}]: ${verdict.reason ?? ''} — ${command.slice(0, 120)}`,
      'the task is aborted to QUARANTINE on a guardrail violation',
    );
  }
}

/** Env vars stripped from every child process, in addition to what scrubEnv already removes. */
export const STRIPPED_ENV: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCP_SERVICE_ACCOUNT_KEY',
];

/**
 * Sanitized environment for daemon children: the existing scrubEnv allowlist (which already
 * drops every secret-looking name) plus the daemon markers, with the named provider
 * credentials deleted explicitly as defense in depth.
 */
export function daemonEnv(
  env: NodeJS.ProcessEnv,
  opts: { passthrough?: readonly string[]; set?: Record<string, string> } = {},
): Record<string, string> {
  const scrubbed = scrubEnv(env, {
    ...(opts.passthrough !== undefined ? { passthrough: opts.passthrough } : {}),
    set: { OMNEXX_SANDBOX: '1', CI: 'true', ...opts.set },
  });
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scrubbed)) {
    if (!STRIPPED_ENV.includes(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependency supply-chain
// ---------------------------------------------------------------------------

export interface PackageAgeCheck {
  pkg: string;
  version: string;
  publishedAt?: string | undefined;
  ageDays?: number | undefined;
  ok: boolean;
  reason?: string | undefined;
}

/**
 * Minimum publish age (default 7 days): a version published more recently than that is
 * too fresh to trust for an unattended install.
 */
export async function checkPackagePublishAge(
  pkg: string,
  version: string,
  minAgeDays = 7,
  now: number = Date.now(),
): Promise<PackageAgeCheck> {
  const r = await execa('npm', ['view', `${pkg}@${version}`, 'time', '--json'], {
    reject: false,
  }).catch((err: unknown) => ({ stdout: '', stderr: (err as Error).message, exitCode: -1 }));
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    return {
      pkg,
      version,
      ok: false,
      reason: `npm view failed: ${r.stderr.slice(0, 200)}`,
    };
  }
  let times: Record<string, string>;
  try {
    times = JSON.parse(r.stdout) as Record<string, string>;
  } catch {
    return { pkg, version, ok: false, reason: 'npm view returned unparsable JSON' };
  }
  const publishedAt = times[version];
  if (!publishedAt) return { pkg, version, ok: false, reason: `version ${version} not on npm` };
  const ageDays = (now - Date.parse(publishedAt)) / 86_400_000;
  return {
    pkg,
    version,
    publishedAt,
    ageDays,
    ok: ageDays >= minAgeDays,
    ...(ageDays < minAgeDays
      ? { reason: `published ${ageDays.toFixed(1)} days ago (< ${minAgeDays} day minimum)` }
      : {}),
  };
}

/**
 * Install with scripts disabled throughout: resolve first (`--package-lock-only`), then a
 * clean `npm ci`, both `--ignore-scripts` so a malicious postinstall cannot run.
 */
export async function installDepsLocked(cwd: string): Promise<{ ok: boolean; error?: string }> {
  for (const args of [
    ['install', '--ignore-scripts', '--package-lock-only'],
    ['ci', '--ignore-scripts'],
  ]) {
    const r = await execa('npm', args, { cwd, reject: false, env: daemonEnv(process.env) }).catch(
      (err: unknown) => ({ stdout: '', stderr: (err as Error).message, exitCode: -1 }),
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        error: `npm ${args.join(' ')} failed: ${r.stderr.slice(0, 300)}`,
      };
    }
  }
  return { ok: true };
}

export interface AuditDelta {
  total: number;
  baseline: number;
  delta: number;
  ok: boolean;
}

/**
 * `npm audit` delta must be ≤ baseline: an install that adds vulnerabilities is refused.
 * Returns `ok: false` with the delta when the audit itself cannot run.
 */
export async function auditDelta(cwd: string, baseline: number): Promise<AuditDelta> {
  const r = await execa('npm', ['audit', '--json'], { cwd, reject: false }).catch(
    (err: unknown) => ({ stdout: '', stderr: (err as Error).message, exitCode: -1 }),
  );
  if (!r.stdout.trim()) {
    return { total: Number.NaN, baseline, delta: Number.NaN, ok: false };
  }
  let parsed: { metadata?: { vulnerabilities?: { total?: number } } };
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    return { total: Number.NaN, baseline, delta: Number.NaN, ok: false };
  }
  const total = parsed.metadata?.vulnerabilities?.total ?? 0;
  return { total, baseline, delta: total - baseline, ok: total - baseline <= 0 };
}
