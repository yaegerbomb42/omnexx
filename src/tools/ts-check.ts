import { askTsWorker, disposeTsWorkers, hasRepoTypescript, LS_PRELUDE } from './ts-worker.js';

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

/** The worker answers "diagnostics for this file before and after the edit". */
const WORKER_SOURCE = `${LS_PRELUDE}
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
  reply(id, () => {
    try {
      return { before: diags(file, before), after: diags(file, after) };
    } finally {
      overrides.delete(file);
      versions.set(file, (versions.get(file) || 0) + 1);
    }
  });
});
`;

export const TS_EXTENSIONS = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

/** True when the repo has its own TypeScript and a tsconfig at the root. */
export const canCheck = hasRepoTypescript;

/**
 * Diagnostics for `file` before and after an edit, or null when the repo has no TypeScript, the
 * checker failed, or it took longer than `timeoutMs` (the checker keeps warming in the background,
 * so the next edit is usually fast).
 */
export async function checkTs(
  root: string,
  file: string,
  before: string,
  after: string,
  timeoutMs: number,
): Promise<DiagPair | null> {
  const r = await askTsWorker<DiagPair>(
    'check',
    WORKER_SOURCE,
    root,
    { file, before, after },
    timeoutMs,
  );
  return r;
}

/** Stop every warm checker (tests, shutdown). */
export const disposeCheckers = disposeTsWorkers;
