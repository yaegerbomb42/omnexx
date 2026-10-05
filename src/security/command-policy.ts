import { basename, resolve } from 'node:path';
import { parse, type ParseEntry } from 'shell-quote';
import { isInside, isSecretPath } from './paths.js';
import { isSecretEnvName } from './redact.js';

export type PolicyVerdict = { allowed: true } | { allowed: false; rule: string; reason: string };

export interface PolicyContext {
  /** The worktree; the command runs with this as cwd. */
  root: string;
  home: string;
  allowNetwork: boolean;
  extraDeny: readonly string[];
  /** Scratch dirs outside the worktree that commands may write into (the run's own tmp dir). */
  scratch: readonly string[];
}

const ALWAYS_DENY: Record<string, string> = {
  sudo: 'privilege escalation',
  su: 'privilege escalation',
  doas: 'privilege escalation',
  ssh: 'remote access',
  scp: 'remote access',
  sftp: 'remote access',
  rsync: 'remote copy',
  nc: 'raw network',
  ncat: 'raw network',
  netcat: 'raw network',
  telnet: 'raw network',
  socat: 'raw network',
  docker: 'container control',
  podman: 'container control',
  kubectl: 'cluster control',
  crontab: 'scheduling',
  launchctl: 'service control',
  systemctl: 'service control',
  shutdown: 'host control',
  reboot: 'host control',
  halt: 'host control',
  kill: 'killing processes the run did not start',
  pkill: 'killing processes the run did not start',
  killall: 'killing processes the run did not start',
  mkfs: 'disk formatting',
  eval: 'unanalyzable command',
  exec: 'unanalyzable command',
  source: 'unanalyzable command',
  '.': 'unanalyzable command',
  gh: 'GitHub API access',
  security: 'keychain access',
};

const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'aria2c']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php']);
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'command', 'builtin', 'stdbuf']);
const GIT_READ = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'grep',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'describe',
  'shortlog',
  'cat-file',
  'rev-list',
  'merge-base',
  'help',
  'version',
]);
const PKG_DENY = new Set([
  'publish',
  'unpublish',
  'login',
  'logout',
  'adduser',
  'token',
  'deprecate',
  'dist-tag',
  'owner',
  'access',
  'whoami',
]);
const WRITERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'cp',
  'mv',
  'tee',
  'touch',
  'mkdir',
  'ln',
  'chmod',
  'chown',
  'chgrp',
  'truncate',
  'install',
]);

const deny = (rule: string, reason: string): PolicyVerdict => ({ allowed: false, rule, reason });
const ALLOW: PolicyVerdict = { allowed: true };

const isOp = (t: ParseEntry): t is Extract<ParseEntry, { op: string }> & { op: string } =>
  typeof t === 'object' && 'op' in t && t.op !== 'glob';
const word = (t: ParseEntry): string | undefined =>
  typeof t === 'string'
    ? t
    : typeof t === 'object' && 'op' in t && t.op === 'glob'
      ? (t as { pattern: string }).pattern
      : undefined;

const CONTROL = new Set([';', '&&', '||', '|', '&', '|&', '(', ')', ';;']);
const REDIRECT_OUT = new Set(['>', '>>', '>|', '&>', '>&', '&>>']);

class Checker {
  constructor(private readonly ctx: PolicyContext) {}

  private abs(p: string): string {
    const expanded =
      p === '~' ? this.ctx.home : p.startsWith('~/') ? this.ctx.home + p.slice(1) : p;
    return resolve(this.ctx.root, expanded);
  }

  private writable(p: string): boolean {
    if (p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr') return true;
    const a = this.abs(p);
    if (a === this.ctx.root || basename(a) === '.git') return false;
    if (isInside(this.ctx.root, a)) return !isInside(resolve(this.ctx.root, '.git'), a);
    // Only the run's own scratch dir, never its root: a broad "/tmp/omnexx-*" rule would also
    // match OMNEXX_HOME under the system temp dir and let `rm -rf ../` reach other worktrees.
    return this.ctx.scratch.some((s) => isInside(s, a) && a !== s);
  }

  private looksLikePath(arg: string): boolean {
    return arg.includes('/') || arg.startsWith('~') || arg.startsWith('.');
  }

  check(command: string, depth = 0): PolicyVerdict {
    if (depth > 3) return deny('nesting', 'too many nested shells');
    if (/\$\(|`|<\(|>\(/.test(command)) {
      return deny('substitution', 'command or process substitution is not allowed');
    }
    for (const m of command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = m[1] ?? '';
      if (isSecretEnvName(name)) return deny('secret-env', `references $${name}`);
    }
    let tokens: ParseEntry[];
    try {
      tokens = parse(command, (name) => `$${name}`);
    } catch {
      return deny('parse', 'cannot parse the command');
    }

    // Split into simple commands, remembering what each one pipes into.
    const segments: { words: string[]; pipedTo?: string[] }[] = [];
    let current: string[] = [];
    let prevPipe: { words: string[] } | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === undefined) continue;
      if (isOp(t)) {
        if (REDIRECT_OUT.has(t.op) || t.op === '<') {
          const target =
            tokens[i + 1] !== undefined ? word(tokens[i + 1] as ParseEntry) : undefined;
          i++;
          if (target === undefined) continue;
          if (/^\d+$/.test(target) || target === '-') continue; // fd duplication like 2>&1
          if (isSecretPath(target)) return deny('secret-path', `redirect touches ${target}`);
          if (t.op !== '<' && !this.writable(target)) {
            return deny('write-outside', `redirect writes outside the worktree: ${target}`);
          }
          continue;
        }
        if (CONTROL.has(t.op)) {
          const seg = { words: current };
          if (prevPipe) Object.assign(prevPipe, { pipedTo: current });
          if (current.length) segments.push(seg);
          prevPipe = t.op === '|' || t.op === '|&' ? seg : undefined;
          current = [];
          continue;
        }
        return deny('operator', `shell operator "${t.op}" is not allowed`);
      }
      if (typeof t === 'object' && 'comment' in t) continue;
      const w = word(t);
      if (w !== undefined) current.push(w);
    }
    if (prevPipe) Object.assign(prevPipe, { pipedTo: current });
    if (current.length) segments.push({ words: current });

    for (const seg of segments) {
      const verdict = this.simple(seg.words, (seg as { pipedTo?: string[] }).pipedTo, depth);
      if (!verdict.allowed) return verdict;
    }
    return ALLOW;
  }

  private simple(words: string[], pipedTo: string[] | undefined, depth: number): PolicyVerdict {
    let argv = words.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || words.indexOf(w) > 0);
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) argv = argv.slice(1);
    // Look through wrappers like `env FOO=1 cmd` or `timeout 30 cmd`.
    for (;;) {
      const head = basename(argv[0] ?? '');
      if (WRAPPERS.has(head)) {
        argv = argv.slice(1);
        while (
          argv.length &&
          ((argv[0] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? ''))
        ) {
          argv = argv.slice(1);
        }
        continue;
      }
      if (head === 'timeout') {
        argv = argv.slice(1).filter((_, i, a) => i > 0 || !(a[0] ?? '').startsWith('-'));
        if (/^\d/.test(argv[0] ?? '')) argv = argv.slice(1);
        continue;
      }
      break;
    }
    const name = basename(argv[0] ?? '');
    if (!name) return ALLOW;
    const args = argv.slice(1);

    if (this.ctx.extraDeny.includes(name))
      return deny('config-deny', `${name} is denied by [policy].deny`);
    const always = ALWAYS_DENY[name];
    if (always) return deny(`deny:${name}`, `${name} is not allowed (${always})`);
    if (NETWORK.has(name)) {
      if (pipedTo && INTERPRETERS.has(basename(pipedTo[0] ?? ''))) {
        return deny('curl-pipe-shell', `${name} piped into ${pipedTo[0] ?? 'a shell'}`);
      }
      if (!this.ctx.allowNetwork) {
        return deny('network', `${name} is not allowed (set [policy] allow_network = true)`);
      }
    }
    if (name === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (
        args.some((a) => a === '-C' || a.startsWith('--git-dir') || a.startsWith('--work-tree'))
      ) {
        return deny('git-redirect', 'git -C / --git-dir / --work-tree are not allowed');
      }
      if (!sub || !GIT_READ.has(sub)) {
        return deny(
          'git-write',
          `git ${sub ?? ''} is not allowed; only the harness changes git state`.trim(),
        );
      }
    }
    if (['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(name)) {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub && PKG_DENY.has(sub)) return deny('publish', `${name} ${sub} is not allowed`);
    }
    if (SHELLS.has(name)) {
      const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const inner = ci >= 0 ? args[ci + 1] : undefined;
      if (inner !== undefined) return this.check(inner, depth + 1);
    }
    if (name === 'dd') {
      const of = args.find((a) => a.startsWith('of='));
      if (of && !this.writable(of.slice(3)))
        return deny('write-outside', `dd writes to ${of.slice(3)}`);
    }
    if (
      name === 'sed' &&
      args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')
    ) {
      for (const a of args.filter((x) => !x.startsWith('-')).slice(1)) {
        if (!this.writable(a)) return deny('write-outside', `sed -i writes ${a}`);
      }
    }
    for (const a of args) {
      if (this.looksLikePath(a) && isSecretPath(a.replace(/^~/, ''))) {
        return deny('secret-path', `${a} looks like a credential path`);
      }
    }
    if (WRITERS.has(name)) {
      for (const a of args.filter((x) => !x.startsWith('-'))) {
        if (!this.writable(a)) {
          return deny(
            'write-outside',
            `${name} ${a}: outside the worktree (or the worktree root/.git)`,
          );
        }
      }
    }
    return ALLOW;
  }
}

/** Decide whether the agent's `bash` tool may run `command`. Deterministic and side-effect free. */
export function checkCommand(command: string, ctx: PolicyContext): PolicyVerdict {
  return new Checker(ctx).check(command);
}
