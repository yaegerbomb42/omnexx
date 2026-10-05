import { execa } from 'execa';
import pc from 'picocolors';
import { findAnthropicKey, maskKey } from '../../auth/keys.js';
import type { OmnexxConfig } from '../../config/schema.js';
import type { OmnexxPaths } from '../../core/paths.js';
import { isTrustedJudgeHost, MIN_OLLAMA, versionAtLeast } from '../../judge/endpoint.js';

export { versionAtLeast } from '../../judge/endpoint.js';
import { println, type CliIO } from '../io.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  paths: OmnexxPaths;
  config: OmnexxConfig;
  offline: boolean;
  nodeVersion: string;
  /** `<binary> --version`, first line, or undefined when not on PATH. */
  versionOf: (binary: string) => Promise<string | undefined>;
  fetch: typeof fetch;
  now: () => number;
}

export async function binaryVersion(binary: string): Promise<string | undefined> {
  const r = await execa(binary, ['--version'], { reject: false, timeout: 10_000, stdin: 'ignore' });
  if (r.failed) return undefined;
  return r.stdout.split('\n')[0]?.trim() ?? '';
}

async function fetchJson(
  f: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function judgeChecks(deps: DoctorDeps): Promise<Check[]> {
  const { nimble } = deps.config.judge;
  const base = nimble.url.replace(/\/+$/, '');
  const host = new URL(base).hostname;
  const checks: Check[] = [];
  checks.push(
    isTrustedJudgeHost(host)
      ? { name: 'judge endpoint', status: 'ok', detail: `${base} (loopback or Tailscale)` }
      : {
          name: 'judge endpoint',
          status: 'warn',
          detail: `${base} is neither loopback nor a Tailscale address; Ollama has no auth, see docs/judge.md`,
        },
  );
  if (deps.offline) {
    checks.push({ name: 'judge reachability', status: 'skip', detail: '--offline' });
    return checks;
  }
  const started = deps.now();
  const version = await fetchJson(deps.fetch, `${base}/api/version`, nimble.timeout_ms);
  const latency = deps.now() - started;
  if (!version.ok) {
    checks.push({
      name: 'judge reachability',
      status: 'warn',
      detail: `unreachable (${version.reason}); runs still start and the judge fails open`,
    });
    return checks;
  }
  const v = (version.body as { version?: unknown }).version;
  const vs = typeof v === 'string' ? v : 'unknown';
  checks.push({
    name: 'judge reachability',
    status: 'ok',
    detail: `reachable, ${latency} ms round trip`,
  });
  checks.push(
    versionAtLeast(vs, MIN_OLLAMA)
      ? { name: 'ollama version', status: 'ok', detail: vs }
      : { name: 'ollama version', status: 'warn', detail: `${vs}; Nimble needs Ollama >= 0.35.0` },
  );
  const tags = await fetchJson(deps.fetch, `${base}/api/tags`, nimble.timeout_ms);
  const models = tags.ok
    ? ((tags.body as { models?: { name?: unknown }[] }).models ?? []).map((m) => String(m.name))
    : [];
  const wanted = nimble.model;
  const pulled = models.some((m) => m === wanted || m.startsWith(`${wanted}:`));
  checks.push(
    pulled
      ? { name: 'nimble model', status: 'ok', detail: `${wanted} is pulled` }
      : {
          name: 'nimble model',
          status: 'warn',
          detail: tags.ok
            ? `${wanted} not pulled (run \`ollama pull ${wanted}\` on that machine)`
            : `cannot list models (${tags.reason})`,
        },
  );
  return checks;
}

export async function runDoctorChecks(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(
    versionAtLeast(deps.nodeVersion, [22, 0, 0])
      ? { name: 'node', status: 'ok', detail: deps.nodeVersion }
      : { name: 'node', status: 'fail', detail: `${deps.nodeVersion}; Omnexx needs Node >= 22` },
  );
  const gitV = await deps.versionOf('git');
  checks.push(
    gitV
      ? { name: 'git', status: 'ok', detail: gitV }
      : { name: 'git', status: 'fail', detail: 'git not found on PATH' },
  );
  const rgV = await deps.versionOf('rg');
  checks.push(
    rgV
      ? { name: 'ripgrep', status: 'ok', detail: rgV }
      : {
          name: 'ripgrep',
          status: 'warn',
          detail: 'rg not found; search falls back to a slower JS scan',
        },
  );
  const key = await findAnthropicKey(deps.paths, deps.env);
  checks.push(
    key
      ? {
          name: 'anthropic key',
          status: 'ok',
          detail: `present (${maskKey(key.key)}) from ${key.source}`,
        }
      : {
          name: 'anthropic key',
          status: 'fail',
          detail: 'missing: set ANTHROPIC_API_KEY or run `omnexx auth set anthropic`',
        },
  );
  if (deps.config.sandbox === 'docker') {
    const d = await deps.versionOf('docker');
    checks.push(
      d
        ? {
            name: 'docker',
            status: 'warn',
            detail: `${d}; sandbox = "docker" itself arrives in M3`,
          }
        : {
            name: 'docker',
            status: 'fail',
            detail: 'sandbox = "docker" but docker is not on PATH',
          },
    );
  }
  if (deps.offline) {
    checks.push({ name: 'provider network', status: 'skip', detail: '--offline' });
  } else {
    const base = deps.config.providers.anthropic.base_url ?? 'https://api.anthropic.com';
    try {
      // No key is sent: any HTTP answer proves DNS, TLS and routing work.
      const res = await deps.fetch(base, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
      checks.push({
        name: 'provider network',
        status: 'ok',
        detail: `${new URL(base).host} answered HTTP ${res.status}`,
      });
    } catch (err) {
      checks.push({
        name: 'provider network',
        status: 'warn',
        detail: `cannot reach ${new URL(base).host}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const gates = deps.config.gates;
  checks.push(
    gates.length
      ? { name: 'gates', status: 'ok', detail: gates.map((g) => g.name).join(', ') }
      : {
          name: 'gates',
          status: 'warn',
          detail: 'no gates configured; run `omnexx init` in your repo',
        },
  );
  if (deps.config.judge.kind === 'nimble') checks.push(...(await judgeChecks(deps)));
  for (const [id, w] of Object.entries(deps.config.workers.backends)) {
    if (w.enabled) {
      checks.push({
        name: `worker ${id}`,
        status: 'fail',
        detail: 'enabled, but worker adapters are not available until M3',
      });
    }
  }
  return checks;
}

const ICON: Record<CheckStatus, string> = {
  ok: pc.green('ok  '),
  warn: pc.yellow('warn'),
  fail: pc.red('fail'),
  skip: pc.dim('skip'),
};

export function renderChecks(io: CliIO, checks: readonly Check[]): void {
  for (const c of checks) println(io.stdout, `${ICON[c.status]} ${c.name.padEnd(20)} ${c.detail}`);
}
