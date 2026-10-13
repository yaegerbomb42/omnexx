import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { compareVersions, parseVersion } from './model.js';

/**
 * Which omnexx the extension runs. The extension ships its own copy (out/cli), run with the
 * editor's Node, so it works right after install. A global `omnexx` the same version or newer
 * wins, so the terminal and the panel share one install; the omnexx.path setting wins over both.
 */
export interface Engine {
  source: 'setting' | 'global' | 'bundled';
  command: string;
  /** Arguments before omnexx's own (the bundled script). */
  prefix: string[];
  env: NodeJS.ProcessEnv;
  version: string | undefined;
  /** A Windows .cmd shim only runs through a shell. */
  shell: boolean;
}

/** Replaced at build time with the version of the bundled CLI. */
declare const __OMNEXX_VERSION__: string;
export const BUNDLED_VERSION: string =
  typeof __OMNEXX_VERSION__ === 'string' ? __OMNEXX_VERSION__ : '0.0.0';

const VERSION_TIMEOUT_MS = 8_000;
const isWindows = process.platform === 'win32';

let extensionRoot = '';
let cached: Promise<Engine> | undefined;

export function initEngine(context: vscode.ExtensionContext): void {
  extensionRoot = context.extensionPath;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('omnexx.path')) cached = undefined;
    }),
  );
}

/** Forget the choice (after installing omnexx globally, say). */
export function refreshEngine(): void {
  cached = undefined;
}

function versionOf(command: string, shell: boolean): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: VERSION_TIMEOUT_MS, shell }, (err, stdout) => {
      resolve(err ? undefined : parseVersion(stdout));
    });
  });
}

function bundled(): Engine | undefined {
  const script = join(extensionRoot, 'out', 'cli', 'index.js');
  if (!extensionRoot || !existsSync(script)) return undefined;
  return {
    source: 'bundled',
    command: process.execPath,
    prefix: [script],
    // The editor's own executable runs as plain Node with this set.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    version: BUNDLED_VERSION,
    shell: false,
  };
}

async function choose(): Promise<Engine> {
  const configured = vscode.workspace.getConfiguration('omnexx').get<string>('path')?.trim();
  if (configured) {
    const shell = isWindows && /\.(cmd|bat)$/i.test(configured);
    return {
      source: 'setting',
      command: configured,
      prefix: [],
      env: process.env,
      version: await versionOf(configured, shell),
      shell,
    };
  }
  const globalCmd = isWindows ? 'omnexx.cmd' : 'omnexx';
  const globalVersion = await versionOf(globalCmd, isWindows);
  const own = bundled();
  if (globalVersion && (!own || compareVersions(globalVersion, BUNDLED_VERSION) >= 0))
    return {
      source: 'global',
      command: globalCmd,
      prefix: [],
      env: process.env,
      version: globalVersion,
      shell: isWindows,
    };
  if (own) return own;
  throw new Error(
    'omnexx is not installed. Install it with: npm i -g omnexx (or brew install yaegerbomb42/omnexx/omnexx), or set omnexx.path.',
  );
}

export function engine(): Promise<Engine> {
  cached ??= choose();
  return cached;
}
