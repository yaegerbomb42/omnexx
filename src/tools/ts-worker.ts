import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * Shared start of every TypeScript worker: loads the repo's own `typescript` and builds one
 * language service over the root tsconfig, with in-memory `overrides` for unsaved text. Plain JS
 * so it runs as an eval worker without a build step. Defines `ts`, `root`, `overrides`,
 * `versions`, `ls` and `reply(id, fn)`.
 */
export const LS_PRELUDE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const root = workerData.root;
const ts = createRequire(root + '/package.json')('typescript');
const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic() {},
});
const overrides = new Map();
const versions = new Map();
const host = {
  getScriptFileNames: () => [...new Set([...parsed.fileNames, ...overrides.keys()])],
  getScriptVersion: (f) => String(versions.get(f) || 0),
  getScriptSnapshot: (f) => {
    const t = overrides.has(f) ? overrides.get(f) : ts.sys.readFile(f);
    return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
  },
  getCurrentDirectory: () => root,
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};
const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
function reply(id, fn) {
  try {
    parentPort.postMessage({ id, result: fn() });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
}
`;

interface WarmWorker {
  worker: Worker;
  pending: Map<number, (r: unknown) => void>;
  dead: boolean;
}

/** Warm workers by kind and repo root, kept for the whole process (the session). */
const workers = new Map<string, WarmWorker>();
let nextId = 0;

/** True when the repo has its own TypeScript and a tsconfig at the root. */
export function hasRepoTypescript(root: string): boolean {
  return (
    existsSync(join(root, 'node_modules', 'typescript', 'package.json')) &&
    existsSync(join(root, 'tsconfig.json'))
  );
}

function start(source: string, root: string): WarmWorker {
  const worker = new Worker(source, { eval: true, workerData: { root } });
  worker.unref();
  const w: WarmWorker = { worker, pending: new Map(), dead: false };
  const settleAll = (): void => {
    w.dead = true;
    for (const resolve of w.pending.values()) resolve(null);
    w.pending.clear();
  };
  worker.on('message', (m: { id: number; error?: string; result?: unknown }) => {
    const resolve = w.pending.get(m.id);
    w.pending.delete(m.id);
    resolve?.(m.error ? null : (m.result ?? null));
  });
  worker.on('error', settleAll);
  worker.on('exit', settleAll);
  return w;
}

/**
 * Send `message` to the warm worker running `source` for `root` (started on first use) and wait
 * for its result. Null when the repo has no TypeScript, the worker failed, or it took longer than
 * `timeoutMs` (it keeps warming in the background, so the next call is usually fast).
 */
export function askTsWorker<T>(
  kind: string,
  source: string,
  root: string,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<T | null> {
  if (!hasRepoTypescript(root)) return Promise.resolve(null);
  const key = `${kind}\0${root}`;
  let w = workers.get(key);
  if (!w || w.dead) {
    w = start(source, root);
    workers.set(key, w);
  }
  const warm = w;
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      warm.pending.delete(id);
      resolve(null);
    }, timeoutMs);
    timer.unref();
    warm.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r as T | null);
    });
    warm.worker.postMessage({ ...message, id });
  });
}

/** Stop every warm worker (tests, shutdown). */
export async function disposeTsWorkers(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map((w) => w.worker.terminate()));
}
