/**
 * Calibrated feature models behind the `calibrated-local` System-1 backend. Each one is a small
 * logistic over hand-picked signals for one harness gate: deterministic, sub-millisecond, and
 * also used as a safety floor when a remote System-1 model answers (safety never degrades
 * offline or when a remote model under-reacts).
 */

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

interface Signal {
  re: RegExp;
  weight: number;
}

/** Unrecoverable or out-of-scope shell mutations, weighted by how bad they are. */
const DESTRUCTIVE: readonly Signal[] = [
  { re: /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/, weight: 6 },
  { re: /\bgit\s+push\b[^|;&]*(?:\s-f\b|--force\b|--force-with-lease\b|\s\+\S)/, weight: 6 },
  { re: /\bgit\s+clean\s+-[a-z]*f/, weight: 5.5 },
  { re: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, weight: 5 },
  { re: /\bgit\s+branch\s+-D\b/, weight: 4.5 },
  {
    re: /\bgit\s+(?:filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire|stash\s+(?:drop|clear))\b/,
    weight: 5,
  },
  { re: /\bdrop\s+(?:table|database|schema)\b/i, weight: 6.5 },
  { re: /\btruncate\s+table\b/i, weight: 5.5 },
  { re: /\bdelete\s+from\s+\w+\s*(?:;|$)/i, weight: 5 },
  { re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, weight: 6 },
  { re: /\b(?:mkfs|fdisk|wipefs)\b|\bdd\b[^|;]*\bof=\/dev\//, weight: 7 },
  { re: />\s*\/dev\/sd[a-z]/, weight: 7 },
  { re: /\bchmod\s+-R\s+0?777\s+\//, weight: 5.5 },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, weight: 7 },
  { re: /\brm\s+(?:-\S+\s+)*\S*\.env(?:\.\S+)?\b|\bshred\b/, weight: 5 },
  { re: /\bunset\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*/i, weight: 4.5 },
  { re: /(?:^|[;&|]\s*)>\s*\S+\.(?:ts|js|py|go|rs|json|md)\b/, weight: 3.5 },
  { re: /\bsudo\s+rm\b/, weight: 6 },
  { re: /\btruncate\s+-s\s*0\b/, weight: 6.5 },
  {
    re: /\bnpm\s+publish\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bdocker\s+system\s+prune\b/,
    weight: 5,
  },
];

const SEPARATORS = new Set([';', '&&', '||', '|', '&']);
const SCOPED_OUTPUTS = new Set([
  'dist',
  'build',
  'out',
  'coverage',
  'node_modules',
  '.cache',
  'tmp',
  '.turbo',
  '.next',
]);
const WIPE_TARGETS = new Set(['/', '~', '$HOME', '.', '..', '*', './*', '/*', '~/*']);
const MUTATORS = new Set(['rm', 'mv', 'cp', 'chmod', 'chown', 'tee', 'truncate']);

/** Shell words, split on whitespace with `;`, `&&`, `|` kept as their own tokens. */
const words = (command: string): string[] =>
  command
    .replaceAll(';', ' ; ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** The arguments of every `name ...` segment in a command line. */
function segmentsOf(command: string, names: ReadonlySet<string>): string[][] {
  const out: string[][] = [];
  let current: string[] | undefined;
  for (const w of words(command)) {
    if (SEPARATORS.has(w)) current = undefined;
    else if (current) current.push(w);
    else if (names.has(w)) {
      current = [w];
      out.push(current);
    }
  }
  return out;
}

const unquote = (w: string): string => w.replace(/^["']/, '').replace(/["']$/, '');

/** `rm -r` of a whole tree ("wipe"), of a build output ("scoped"), or neither. */
export function recursiveDeleteRisk(command: string): 'wipe' | 'scoped' | 'none' {
  let risk: 'wipe' | 'scoped' | 'none' = 'none';
  for (const [, ...args] of segmentsOf(command, new Set(['rm']))) {
    const flags = args.filter((a) => a.startsWith('-'));
    const recursive = flags.some(
      (f) => f === '--recursive' || (!f.startsWith('--') && /[rR]/.test(f)),
    );
    if (!recursive) continue;
    for (const t of args.filter((a) => !a.startsWith('-')).map(unquote)) {
      const base = t.replace(/^\.\//, '').replace(/\/$/, '');
      if (WIPE_TARGETS.has(t) || t.startsWith('/') || t.startsWith('~/') || t.startsWith('../'))
        return 'wipe';
      if (SCOPED_OUTPUTS.has(base)) risk = 'scoped';
    }
  }
  return risk;
}

const outsideRepo = (command: string, cwd: string, repoRoot: string): boolean => {
  if (repoRoot && cwd && !cwd.startsWith(repoRoot)) return true;
  if (!repoRoot) return false;
  return segmentsOf(command, MUTATORS).some(([, ...args]) =>
    args
      .map(unquote)
      .some(
        (a) =>
          a.startsWith('/') &&
          !a.startsWith('/tmp') &&
          a !== '/dev/null' &&
          !a.startsWith(repoRoot),
      ),
  );
};

/** P(destructive, unrecoverable, or out-of-scope) for a shell command. */
export function destructiveProb(
  command: string,
  cwd = '',
  repoRoot = '',
  allowOutsideRepo = false,
): number {
  const c = command.trim();
  if (!c) return 0.01;
  let z = -4;
  let hit = false;
  for (const s of DESTRUCTIVE) {
    if (s.re.test(c)) {
      z += s.weight;
      hit = true;
    }
  }
  const rm = recursiveDeleteRisk(c);
  if (rm === 'wipe') z += 7;
  else if (rm === 'scoped' && !hit) z += 2.6;
  if (!allowOutsideRepo && outsideRepo(c, cwd, repoRoot)) z += 6.5;
  return sigmoid(z);
}

export interface ContinuationState {
  filesModified: number;
  testsPassed: boolean;
  testsFailed: boolean;
  /** Read-only inspections since the work was last verified green (or answered). */
  redundantReadOnly: number;
  /** The assistant's latest substantive text. */
  assistantSummary: string;
  /** Tool calls still waiting for results. */
  pendingCalls: number;
}

/** P(the user's request is fully resolved) from the loop's recent trace. */
export function completionProb(s: ContinuationState): number {
  if (s.testsFailed || s.pendingCalls > 0) return 0.02;
  let z = -3;
  if (s.filesModified > 0) z += s.testsPassed ? 3 : -2;
  else if (s.assistantSummary.length >= 200) z += 2.2;
  z += Math.min(4, s.redundantReadOnly) * 1.1;
  if (s.assistantSummary.length >= 80) z += 0.8;
  return sigmoid(z);
}

export const TRIAGE_KEYS = [
  'relevant_error_trace',
  'harmless_warnings',
  'irrelevant_noise',
] as const;
export type TriageClass = (typeof TRIAGE_KEYS)[number];

const ERROR_WORDS =
  /\b(?:error|failed|failure|fail|exception|traceback|panic|assert|assertion|expected|received|cannot|fatal|segmentation)\b/i;
const ERROR_MARKS = ['✗', '×', '✕', 'undefined is not', 'not found'];

function isErrorLine(line: string): boolean {
  const t = line.trim();
  if (ERROR_WORDS.test(t) || /\bTS\d{4}\b/.test(t) || /\bexit code [1-9]/i.test(t)) return true;
  if (ERROR_MARKS.some((m) => t.includes(m))) return true;
  if (t.startsWith('at ') && /(?:src|test|lib)\//.test(t)) return true;
  if (t.startsWith('File "') && t.includes('", line ')) return true;
  return /^[-+] {2}/.test(t);
}

const WARN_LINE = /\b(?:warn(?:ing)?|deprecat\w*|notice|peer dep\w*|ExperimentalWarning)\b/i;

const NOISE_PREFIXES = [
  '✓',
  '✔',
  '√',
  'pass',
  'ok ',
  'up to date',
  'found 0 vulnerabilities',
  'run `npm fund`',
  'transforming',
  'rendering chunks',
  'computing gzip',
  'building',
  'bundl',
  'compil',
  'downloading',
  'resolving',
  'fetching',
  'linking',
  'progress',
  '...',
];
const NOISE_PATTERNS = [
  /^\[\d+\/\d+\]/,
  /^(?:added|audited|removed|changed) \d+ packages?/i,
  /^\d+ packages? (?:are )?looking for funding/i,
  /^\S+ +\d+(?:\.\d+)? ?[kmKM]?B\b/,
  /^[-=#*]{6,}$/,
];

function isNoiseLine(line: string): boolean {
  const t = line.trim();
  const lower = t.toLowerCase();
  return NOISE_PREFIXES.some((p) => lower.startsWith(p)) || NOISE_PATTERNS.some((re) => re.test(t));
}

/** Class weights for one output chunk (fractions of its lines that look like each class). */
export function triageWeights(chunk: string): Record<TriageClass, number> {
  const lines = chunk.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return { relevant_error_trace: 0, harmless_warnings: 0, irrelevant_noise: 1 };
  let err = 0;
  let warn = 0;
  let noise = 0;
  for (const l of lines) {
    if (isErrorLine(l)) err++;
    else if (WARN_LINE.test(l)) warn++;
    else if (isNoiseLine(l)) noise++;
  }
  const other = lines.length - err - warn - noise;
  // An error anywhere in a chunk makes the whole chunk worth keeping; unknown lines lean relevant
  // (they may be the direct answer), so only recognizable chatter is ever pruned.
  return {
    relevant_error_trace: err > 0 ? 0.9 + err : other * 0.8,
    harmless_warnings: warn,
    irrelevant_noise: noise,
  };
}

export const INTENT_KEYS = [
  'explain_code',
  'edit_code',
  'run_command',
  'git_operation',
  'ask_clarification',
] as const;
export type IntentClass = (typeof INTENT_KEYS)[number];

const INTENT_SIGNALS: Record<IntentClass, readonly Signal[]> = {
  explain_code: [
    {
      re: /\b(?:where|how (?:does|do|is|are)|explain|show me|find|locate|what (?:does|is)|which file|walk me through|look up|trace)\b/i,
      weight: 2.4,
    },
    { re: /\b(?:defined|implemented|handled|checked|called|used|works?)\b/i, weight: 1.2 },
  ],
  edit_code: [
    {
      re: /\b(?:fix|add|implement|refactor|change|update|rename|remove|delete|write|create|make|replace|migrate|convert|support)\b/i,
      weight: 2.4,
    },
  ],
  run_command: [
    {
      re: /^\s*(?:run|execute|start|build|test|lint|benchmark|install|npm|pnpm|yarn|npx|make|cargo|go test|pytest)\b/i,
      weight: 2.8,
    },
    { re: /\b(?:run the|run all|run tests?|benchmark)\b/i, weight: 1.2 },
  ],
  git_operation: [
    {
      re: /\bgit\b|\b(?:diff|commits?|branch(?:es)?|staged|unstaged|stash|rebase|merge|log)\b/i,
      weight: 2.2,
    },
    { re: /\bwhat (?:changed|did i change)|\buncommitted\b|\bstatus\b/i, weight: 1.8 },
  ],
  ask_clarification: [
    {
      re: /^\s*(?:hi|hello|hey|thanks|thank you|yo|sup|good (?:morning|evening|afternoon))\b/i,
      weight: 3,
    },
  ],
};

/** Unnormalized intent weights (softmax inputs) for a user prompt. */
export function intentWeights(prompt: string): Record<IntentClass, number> {
  const out = {} as Record<IntentClass, number>;
  for (const k of INTENT_KEYS) {
    let z = k === 'ask_clarification' ? 0.4 : 0;
    for (const s of INTENT_SIGNALS[k]) if (s.re.test(prompt)) z += s.weight;
    // One or two words ("thanks", "auth?") are rarely a task on their own.
    if (k === 'ask_clarification' && prompt.trim().split(/\s+/).length <= 2) z += 1.5;
    out[k] = Math.exp(z);
  }
  return out;
}

const COMMENT_PREFIXES = ['//', '#', '/*', '*', '<!--', '--'];
const PLACEHOLDER_PHRASES = [
  /\b(?:rest|remainder) of (?:the )?(?:file|code|implementation|function|class|method|logic)\b/i,
  /\bexisting (?:code|logic|implementation)\b/i,
  /\b(?:code|logic) (?:unchanged|omitted|remains the same)\b/i,
  /\bsame as before\b/i,
  /\bprevious (?:code|implementation)\b/i,
  /\bimplementation (?:here|omitted)\b/i,
  /\btodo:? ?implement\b/i,
];

/** A comment that stands in for code the model didn't bother to write out. */
export function isPlaceholder(line: string): boolean {
  const t = line.trim();
  const prefix = COMMENT_PREFIXES.find((p) => t.startsWith(p));
  if (!prefix) return false;
  const body = t.slice(prefix.length).replace('*/', '').replace('-->', '').trim();
  const bare = body
    .replaceAll('…', '...')
    .replaceAll('.', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
  if (body.length > 0 && bare === '') return true;
  if (bare.toLowerCase() === 'unchanged') return true;
  return PLACEHOLDER_PHRASES.some((re) => re.test(body));
}

const isComment = (l: string): boolean => /^\s*(?:\/\/|#|\/\*|\*|<!--|--)/.test(l);
const codeLines = (s: string): string[] =>
  s.split('\n').filter((l) => l.trim().length > 0 && !isComment(l));

export interface PatchSignals {
  /** Placeholder comments the edit introduces (not already present in the replaced text). */
  placeholders: string[];
  /** Non-comment lines removed from the replaced text and not carried into the new text. */
  droppedCodeLines: number;
  /** Bracket balance change the edit introduces (truncation shows up here). */
  bracketDelta: number;
}

const bracketBalance = (s: string): number => {
  let b = 0;
  for (const ch of s.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')) {
    if (ch === '{' || ch === '(' || ch === '[') b++;
    else if (ch === '}' || ch === ')' || ch === ']') b--;
  }
  return b;
};

export function patchSignals(oldText: string, newText: string): PatchSignals {
  const before = new Set(oldText.split('\n').map((l) => l.trim()));
  const placeholders = newText
    .split('\n')
    .filter((l) => isPlaceholder(l) && !before.has(l.trim()))
    .map((l) => l.trim());
  const kept = new Set(codeLines(newText).map((l) => l.trim()));
  const droppedCodeLines = codeLines(oldText).filter((l) => !kept.has(l.trim())).length;
  return {
    placeholders,
    droppedCodeLines,
    bracketDelta: bracketBalance(newText) - bracketBalance(oldText),
  };
}

/** P(the patch erases real logic behind lazy placeholder comments). */
export function placeholderProb(s: PatchSignals): number {
  if (!s.placeholders.length) return 0.02;
  // A placeholder alone (a new file's doc, a test about comments) is mild; one that stands in for
  // removed code is the lazy-diff failure.
  const z = -2.2 + 1.5 * s.placeholders.length + Math.min(8, s.droppedCodeLines) * 1.4;
  return sigmoid(z);
}

/** Weights over the 5-level completeness rubric (index 0 = "1: truncated" … 4 = "5: clean"). */
export function completenessWeights(s: PatchSignals): Record<string, number> {
  const lazy = placeholderProb(s);
  const truncated = Math.abs(s.bracketDelta) > 0;
  if (truncated && lazy > 0.5) return { '0': 0.7, '1': 0.25, '2': 0.05 };
  if (lazy > 0.85) return { '0': 0.15, '1': 0.7, '2': 0.15 };
  if (truncated) return { '0': 0.55, '1': 0.3, '2': 0.15 };
  if (lazy > 0.5) return { '1': 0.3, '2': 0.6, '3': 0.1 };
  return { '3': 0.25, '4': 0.75 };
}

/** Whether any line of a chunk looks like an error, failure, or stack frame worth keeping. */
export const hasErrorLine = (chunk: string): boolean => chunk.split('\n').some(isErrorLine);
