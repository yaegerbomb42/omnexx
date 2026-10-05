import type { OmnexxConfig } from '../config/schema.js';

export interface UnitInput {
  node: string;
  cli: string;
  path: string;
  home: string;
  /** Extra environment for the supervisor (e.g. OMNEXX_HOME when not the default). */
  env: Record<string, string>;
  service: OmnexxConfig['service'];
  logDir: string;
}

const quoteSystemd = (s: string): string =>
  /[\s"\\]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;

/**
 * systemd user unit (plan §5.2, handoff §4.3): runs `omnexx resume --all` at boot, restarts on
 * failure with backoff, nice'd, optional CPU/memory caps for a VPS shared with production.
 */
export function systemdUnit(u: UnitInput): string {
  const env = { PATH: u.path, ...u.env };
  return [
    '[Unit]',
    'Description=Omnexx supervisor (resumes interrupted runs)',
    'Documentation=https://github.com/yaegerbomb42/omnexx',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteSystemd(u.node)} ${quoteSystemd(u.cli)} resume --all`,
    ...Object.entries(env).map(([k, v]) => `Environment=${quoteSystemd(`${k}=${v}`)}`),
    'Restart=on-failure',
    'RestartSec=30',
    'RestartSteps=5',
    'RestartMaxDelaySec=15min',
    `Nice=${u.service.nice}`,
    ...(u.service.cpu_quota ? [`CPUQuota=${u.service.cpu_quota}`] : []),
    ...(u.service.memory_max ? [`MemoryMax=${u.service.memory_max}`] : []),
    'KillMode=control-group',
    'TimeoutStopSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const LAUNCHD_LABEL = 'org.omnexx.supervisor';

/** launchd LaunchAgent: run at login, keep alive only after a failed exit, throttled. */
export function launchdPlist(u: UnitInput): string {
  const env = { PATH: u.path, ...u.env };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[u.node, u.cli, 'resume', '--all'].map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).flatMap(([k, v]) => [
      `    <key>${xml(k)}</key>`,
      `    <string>${xml(v)}</string>`,
    ]),
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key>',
    '  <dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    `  <key>Nice</key><integer>${u.service.nice}</integer>`,
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xml(`${u.logDir}/service.log`)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(`${u.logDir}/service.log`)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
