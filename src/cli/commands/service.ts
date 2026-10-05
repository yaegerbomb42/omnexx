import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { loadConfig } from '../../config/load.js';
import { resolvePaths } from '../../core/paths.js';
import { launchdPlist, LAUNCHD_LABEL, systemdUnit, type UnitInput } from '../../daemon/units.js';
import { NotImplementedError, UsageError } from '../../errors.js';
import { EXIT } from '../exit-codes.js';
import { println, type CliIO } from '../io.js';

export type Exec = (cmd: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;

const realExec: Exec = async (cmd, args) => {
  const r = await execa(cmd, args, { reject: false, stdin: 'ignore' });
  return { exitCode: r.exitCode ?? 1, stdout: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}` };
};

/** A stable node path (e.g. /opt/homebrew/bin/node) rather than a versioned Cellar path that breaks on upgrade. */
export function nodeOnPath(path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'node');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface ServiceTarget {
  kind: 'systemd' | 'launchd';
  file: string;
  content: string;
  install: [string, string[]][];
  uninstall: [string, string[]][];
  status: [string, string[]];
}

export async function serviceTarget(
  io: CliIO,
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceTarget> {
  const { config } = await loadConfig({ cwd: io.cwd, env: io.env, skipProject: true });
  const paths = resolvePaths(io.env);
  const home = io.env.HOME ?? homedir();
  const extra: Record<string, string> = {};
  if (io.env.OMNEXX_HOME) extra.OMNEXX_HOME = io.env.OMNEXX_HOME;
  if (io.env.OMNEXX_CONFIG_HOME) extra.OMNEXX_CONFIG_HOME = io.env.OMNEXX_CONFIG_HOME;
  const unit: UnitInput = {
    node: nodeOnPath(io.env.PATH) ?? process.execPath,
    cli: resolve(process.argv[1] ?? 'omnexx'),
    path: io.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    home,
    env: extra,
    service: config.service,
    logDir: paths.home,
  };
  if (platform === 'linux') {
    const file = join(
      io.env.XDG_CONFIG_HOME ?? join(home, '.config'),
      'systemd',
      'user',
      'omnexx.service',
    );
    return {
      kind: 'systemd',
      file,
      content: systemdUnit(unit),
      install: [
        ['systemctl', ['--user', 'daemon-reload']],
        ['systemctl', ['--user', 'enable', '--now', 'omnexx.service']],
      ],
      uninstall: [
        ['systemctl', ['--user', 'disable', '--now', 'omnexx.service']],
        ['systemctl', ['--user', 'daemon-reload']],
      ],
      status: ['systemctl', ['--user', 'status', '--no-pager', 'omnexx.service']],
    };
  }
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${userInfo().uid}`;
    return {
      kind: 'launchd',
      file,
      content: launchdPlist(unit),
      install: [['launchctl', ['bootstrap', domain, file]]],
      uninstall: [['launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]]],
      status: ['launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`]],
    };
  }
  throw new NotImplementedError(`service install on ${platform}`, 'a later milestone');
}

/** Linux only: without linger, user services stop at logout and don't start at boot. */
export async function lingerHint(exec: Exec, user: string): Promise<string | undefined> {
  const r = await exec('loginctl', ['show-user', user, '-p', 'Linger']);
  if (r.exitCode === 0 && r.stdout.includes('Linger=yes')) return undefined;
  return `Linger is off for ${user}: the service won't start at boot until you run\n  sudo loginctl enable-linger ${user}`;
}

export async function serviceCommand(
  io: CliIO,
  action: string,
  dryRun: boolean,
  exec: Exec = realExec,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const t = await serviceTarget(io, platform);
  if (action === 'install') {
    if (dryRun) {
      io.stdout.write(t.content);
      println(io.stderr, `(dry run: would write ${t.file})`);
      return EXIT.ok;
    }
    await mkdir(dirname(t.file), { recursive: true });
    await writeFile(t.file, t.content);
    println(io.stdout, `wrote ${t.file}`);
    for (const [cmd, args] of t.install) {
      const r = await exec(cmd, args);
      if (r.exitCode !== 0)
        throw new UsageError(
          `${cmd} ${args.join(' ')} failed: ${r.stdout.trim().split('\n')[0] ?? ''}`,
        );
    }
    if (t.kind === 'systemd') {
      const hint = await lingerHint(exec, io.env.USER ?? userInfo().username);
      if (hint) println(io.stdout, hint);
    }
    println(io.stdout, `installed (${t.kind}); it runs \`omnexx resume --all\` at boot`);
    return EXIT.ok;
  }
  if (action === 'uninstall') {
    for (const [cmd, args] of t.uninstall) await exec(cmd, args);
    await rm(t.file, { force: true });
    println(io.stdout, `removed ${t.file}`);
    return EXIT.ok;
  }
  if (action === 'status') {
    const r = await exec(...t.status);
    io.stdout.write(`${r.stdout}\n`);
    return r.exitCode === 0 ? EXIT.ok : EXIT.error;
  }
  throw new UsageError(`unknown service action "${action}"`, 'use install, uninstall or status');
}
