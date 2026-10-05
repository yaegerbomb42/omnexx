import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../../../src/cli/io.js';
import {
  lingerHint,
  nodeOnPath,
  serviceCommand,
  serviceTarget,
  type Exec,
} from '../../../src/cli/commands/service.js';
import { defaultConfig } from '../../../src/config/load.js';
import { launchdPlist, systemdUnit } from '../../../src/daemon/units.js';
import { isolatedEnv, tempDir } from '../../support/tmp.js';

const unit = {
  node: '/usr/bin/node',
  cli: '/opt/omnexx/dist/cli.js',
  path: '/usr/bin:/bin',
  home: '/home/me',
  env: { OMNEXX_HOME: '/srv/omnexx state' },
  service: defaultConfig({ service: { cpu_quota: '150%', memory_max: '4G' } }).service,
  logDir: '/home/me/.omnexx',
};

async function io(): Promise<{ io: CliIO; out: () => string }> {
  const env = await isolatedEnv();
  env.XDG_CONFIG_HOME = await tempDir();
  env.HOME = await tempDir();
  env.USER = 'me';
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (c: Buffer) => (text += c.toString()));
  return {
    io: {
      stdout,
      stderr: new PassThrough(),
      stdin: Readable.from([]),
      env,
      cwd: await tempDir(),
      isTTY: false,
    },
    out: () => text,
  };
}

describe('unit generation', () => {
  it('systemd: resume --all, restart with backoff, nice, quotas, quoted env', () => {
    const u = systemdUnit(unit);
    expect(u).toContain('ExecStart=/usr/bin/node /opt/omnexx/dist/cli.js resume --all');
    expect(u).toContain('Restart=on-failure');
    expect(u).toContain('RestartSec=30');
    expect(u).toContain('Nice=10');
    expect(u).toContain('CPUQuota=150%');
    expect(u).toContain('MemoryMax=4G');
    expect(u).toContain('Environment="OMNEXX_HOME=/srv/omnexx state"');
    expect(u).toContain('WantedBy=default.target');
    expect(systemdUnit({ ...unit, service: defaultConfig().service })).not.toContain('CPUQuota');
  });
  it('launchd: RunAtLoad, KeepAlive on failure only, escaped XML', () => {
    const p = launchdPlist({ ...unit, env: { X: 'a&b<c>' } });
    expect(p).toContain('<string>resume</string>');
    expect(p).toContain('<key>SuccessfulExit</key><false/>');
    expect(p).toContain('<string>a&amp;b&lt;c&gt;</string>');
  });
});

describe('omnexx service', () => {
  it('install on linux writes the user unit, enables it, and prints the linger command when linger is off', async () => {
    const { io: cli, out } = await io();
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return Promise.resolve(
        cmd === 'loginctl' ? { exitCode: 0, stdout: 'Linger=no' } : { exitCode: 0, stdout: '' },
      );
    };
    expect(await serviceCommand(cli, 'install', false, exec, 'linux')).toBe(0);
    const file = join(String(cli.env.XDG_CONFIG_HOME), 'systemd', 'user', 'omnexx.service');
    expect(await readFile(file, 'utf8')).toContain('resume --all');
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now omnexx.service',
      'loginctl show-user me -p Linger',
    ]);
    expect(out()).toContain('sudo loginctl enable-linger me');
    expect(await serviceCommand(cli, 'status', false, exec, 'linux')).toBe(0);
    expect(await serviceCommand(cli, 'uninstall', false, exec, 'linux')).toBe(0);
    await expect(stat(file)).rejects.toThrow();
  });

  it('install on macOS writes a LaunchAgent and bootstraps it; --dry-run only prints', async () => {
    const { io: cli, out } = await io();
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args[0] ?? ''}`);
      return Promise.resolve({ exitCode: 0, stdout: '' });
    };
    expect(await serviceCommand(cli, 'install', true, exec, 'darwin')).toBe(0);
    expect(out()).toContain('<key>Label</key><string>org.omnexx.supervisor</string>');
    expect(calls).toEqual([]);
    await serviceCommand(cli, 'install', false, exec, 'darwin');
    expect(calls).toEqual(['launchctl bootstrap']);
    expect((await serviceTarget(cli, 'darwin')).file).toMatch(
      /Library\/LaunchAgents\/org\.omnexx\.supervisor\.plist$/,
    );
  });

  it('errors and helpers', async () => {
    const { io: cli } = await io();
    const failing: Exec = () =>
      Promise.resolve({ exitCode: 1, stdout: 'Failed to connect to bus' });
    await expect(serviceCommand(cli, 'install', false, failing, 'linux')).rejects.toThrow(
      /Failed to connect to bus/,
    );
    await expect(serviceCommand(cli, 'frob', false, failing, 'linux')).rejects.toThrow(
      /unknown service action/,
    );
    await expect(serviceTarget(cli, 'win32')).rejects.toThrow(/not implemented/);
    expect(
      await lingerHint(() => Promise.resolve({ exitCode: 0, stdout: 'Linger=yes' }), 'me'),
    ).toBeUndefined();
    expect(nodeOnPath('/nonexistent:/also-not')).toBeUndefined();
    expect(nodeOnPath(process.env.PATH)).toMatch(/node$/);
  });
});
