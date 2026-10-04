import { isSecretEnvName } from './redact.js';

const ALLOW = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TZ',
  'TMPDIR',
  'CI',
  'COLUMNS',
  'LINES',
  'NODE_ENV',
  'GOPATH',
  'GOCACHE',
  'GOMODCACHE',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'JAVA_HOME',
]);

/**
 * Build the minimal environment for every child process (gates, bash tool, workers).
 * Nothing secret-looking passes, even when listed in `passthrough`: the API key lives only in
 * the supervisor process.
 */
export function scrubEnv(
  env: NodeJS.ProcessEnv,
  opts: { passthrough?: readonly string[]; set?: Record<string, string> } = {},
): Record<string, string> {
  const allowed = new Set([...ALLOW, ...(opts.passthrough ?? [])]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!(allowed.has(name) || name.startsWith('LC_'))) continue;
    if (isSecretEnvName(name)) continue;
    out[name] = value;
  }
  return { ...out, OMNEXX: '1', GIT_TERMINAL_PROMPT: '0', ...opts.set };
}
