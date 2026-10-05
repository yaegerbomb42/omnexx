import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { quote } from 'shell-quote';
import type { OmnexxConfig } from '../config/schema.js';
import { runShell, type ExecOptions, type ExecResult, type Executor } from '../core/exec.js';
import { OmnexxError } from '../errors.js';

export interface SandboxSpec {
  /** Container name, unique per run. */
  name: string;
  worktree: string;
  /** The run's scratch dir (TMPDIR for commands). */
  tmpDir: string;
  /** The main repo's .git dir, mounted read-only so read-only git works inside. */
  gitDir: string | undefined;
  docker: OmnexxConfig['docker'];
  uid: number;
  gid: number;
}

/** Env for the host-side docker client only: enough to find the binary and the daemon. */
function clientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** `docker run` argv for the long-lived sandbox container. Pure, so it's unit-tested. */
export function runArgs(s: SandboxSpec): string[] {
  const d = s.docker;
  const mounts = [
    '-v',
    `${s.worktree}:${s.worktree}:rw`,
    '-v',
    `${s.tmpDir}:${s.tmpDir}:rw`,
    ...(s.gitDir ? ['-v', `${s.gitDir}:${s.gitDir}:ro`] : []),
  ];
  return [
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    s.name,
    '--label',
    'org.omnexx.sandbox=1',
    '--user',
    `${s.uid}:${s.gid}`,
    '--network',
    d.network,
    '--cpus',
    d.cpus,
    '--memory',
    d.memory,
    '--pids-limit',
    String(d.pids_limit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    `/tmp:rw,exec,nosuid,size=${d.tmp_size}`,
    '-e',
    'HOME=/tmp/home',
    '-w',
    s.worktree,
    ...mounts,
    d.image,
    'sleep',
    'infinity',
  ];
}

/**
 * `sandbox = "docker"` (plan §3.13): the agent's commands, gates, checks and setup run in one
 * container per run with only the worktree and the run's scratch dir mounted read-write, no
 * capabilities, a read-only root, and CPU/memory/pid limits. The supervisor stays on the host.
 */
export class DockerSandbox {
  private started = false;

  constructor(
    readonly spec: SandboxSpec,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private docker(args: string[], timeoutMs = 120_000) {
    return execa('docker', args, {
      env: clientEnv(this.env),
      extendEnv: false,
      reject: false,
      stdin: 'ignore',
      timeout: timeoutMs,
    });
  }

  async start(): Promise<void> {
    await this.docker(['rm', '-f', this.spec.name]);
    const pull = await this.docker(['image', 'inspect', this.spec.docker.image]);
    if (pull.exitCode !== 0) {
      const p = await this.docker(['pull', this.spec.docker.image], 15 * 60_000);
      if (p.exitCode !== 0)
        throw new OmnexxError(
          'sandbox',
          `cannot pull ${this.spec.docker.image}: ${p.stderr.split('\n')[0] ?? ''}`,
          'check `docker info` and the [docker] image',
        );
    }
    const r = await this.docker(runArgs(this.spec));
    if (r.exitCode !== 0) {
      throw new OmnexxError(
        'sandbox',
        `cannot start the sandbox container: ${r.stderr.split('\n').at(-1) ?? ''}`,
        'run `omnexx doctor`; is the docker daemon running?',
      );
    }
    await this.docker(['exec', this.spec.name, 'mkdir', '-p', '/tmp/home', '/tmp/omnexx-exec']);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.docker(['rm', '-f', this.spec.name]);
    this.started = false;
  }

  /** Run one command inside the container; on timeout/abort the in-container process group dies too. */
  readonly exec: Executor = (command: string, opts: ExecOptions): Promise<ExecResult> => {
    const id = randomBytes(6).toString('hex');
    const pidFile = `/tmp/omnexx-exec/${id}.pid`;
    // setsid gives the command its own process group inside the container, recorded in pidFile.
    const inner = `setsid sh -c ${quote([command])} & p=$!; echo $p > ${pidFile}; wait $p; s=$?; rm -f ${pidFile}; exit $s`;
    const envArgs = Object.entries(opts.env)
      .filter(([k]) => k !== 'PATH' && k !== 'HOME')
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const argv = [
      'docker',
      'exec',
      ...(opts.stdin !== undefined ? ['-i'] : []),
      '-w',
      opts.cwd,
      ...envArgs,
      this.spec.name,
      'sh',
      '-c',
      inner,
    ];
    return runShell(quote(argv), {
      ...opts,
      env: clientEnv(this.env),
      onKill: async () => {
        await this.docker(
          [
            'exec',
            this.spec.name,
            'sh',
            '-c',
            `[ -f ${pidFile} ] && kill -KILL -- -$(cat ${pidFile})`,
          ],
          10_000,
        );
      },
    });
  };
}

/** Is a docker daemon reachable? */
export async function dockerAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], {
    env: clientEnv(env),
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    timeout: 10_000,
  });
  return r.exitCode === 0 && r.stdout.trim() !== '';
}
