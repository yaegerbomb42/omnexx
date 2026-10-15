import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** One diagnostic on the edited file. */
export interface Diag {
  line: number;
  code: string;
  message: string;
}

export interface DiagPair {
  before: Diag[];
  after: Diag[];
}

/**
 * The worker: loads the repo's own `typescript`, keeps one language service warm for the
 * session, and answers "diagnostics for this file before and after the edit". Plain JS so it
 * runs as an eval worker without a build step.
 */
const WORKER_SOURCE = `
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
function diags(file, text) {
  overrides.set(file, text);
  versions.set(file, (versions.get(file) || 0) + 1);
  return [...ls.getSyntacticDiagnostics(file), ...ls.getSemanticDiagnostics(file)].map((d) => ({
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
    code: 'TS' + d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));
}
parentPort.on('message', ({ id, file, before, after }) => {
  try {
    const b = diags(file, before);
    const a = diags(file, after);
    overrides.delete(file);
    versions.set(file, (versions.get(file) || 0) + 1);
    parentPort.postMessage({ id, before: b, after: a });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err) });
  }
});
`;

interface Checker {
  worker: Worker;
  pending: Map<number, (r: DiagPair | null) => void>;
  dead: boolean;
}

/** Warm checkers by repo root, kept for the whole process (the session). */
const checkers = new Map<string, Checker>();
let nextId = 0;

export const TS_EXTENSIONS = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

function startChecker(root: string): Checker {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { root } });
  worker.unref();
  const checker: Checker = { worker, pending: new Map(), dead: false };
  const settleAll = (): void => {
    checker.dead = true;
    for (const resolve of checker.pending.values()) resolve(null);
    checker.pending.clear();
  };
  worker.on('message', (m: { id: number; error?: string } & Partial<DiagPair>) => {
    const resolve = checker.pending.get(m.id);
    checker.pending.delete(m.id);
    resolve?.(m.error || !m.before || !m.after ? null : { before: m.before, after: m.after });
  });
  worker.on('error', settleAll);
  worker.on('exit', settleAll);
  return checker;
}

/** True when the repo has its own TypeScript and a tsconfig at the root. */
export function canCheck(root: string): boolean {
  return (
    existsSync(join(root, 'node_modules', 'typescript', 'package.json')) &&
    existsSync(join(root, 'tsconfig.json'))
  );
}

/**
 * Diagnostics for `file` before and after an edit, or null when the repo has no TypeScript, the
 * checker failed, or it took longer than `timeoutMs` (the checker keeps warming in the background,
 * so the next edit is usually fast).
 */
export function checkTs(
  root: string,
  file: string,
  before: string,
  after: string,
  timeoutMs: number,
): Promise<DiagPair | null> {
  if (!canCheck(root)) return Promise.resolve(null);
  let checker = checkers.get(root);
  if (checker?.dead) checker = undefined;
  if (!checker) {
    checker = startChecker(root);
    checkers.set(root, checker);
  }
  const c = checker;
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      c.pending.delete(id);
      resolve(null);
    }, timeoutMs);
    timer.unref();
    c.pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    c.worker.postMessage({ id, file, before, after });
  });
}

/** Stop every warm checker (tests, shutdown). */
export async function disposeCheckers(): Promise<void> {
  const all = [...checkers.values()];
  checkers.clear();
  await Promise.all(all.map((c) => c.worker.terminate()));
}
