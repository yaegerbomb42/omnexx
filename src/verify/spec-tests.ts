import { z } from 'zod';
import type { OmnexxConfig } from '../config/schema.js';
import type { Run } from '../core/run.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Spec-first acceptance tests. The worker writes code and its own tests, and the two can agree on
 * a wrong behaviour (bench task-10: `fulfil()` of a reservation re-checked available stock, which
 * its own reservation had lowered). An independent model that sees only the goal and the public
 * interface (signatures, never bodies) writes tests for the boundaries and interactions between
 * requirements; they run before the run may finish. The tests live outside the repo (in the run
 * store) and sit in the worktree only while they run, so they are never committed.
 */

/** Where the suite's files sit in the worktree while it runs. */
export const SPEC_DIR = 'omnexx-spec';
/** The worker disputes a spec test by writing this file (git-excluded) with its reason. */
export const DISPUTE_FILE = '.omnexx-spec-dispute.md';
/** `auto` writes spec tests for goals listing at least this many requirements. */
export const MIN_REQUIREMENTS = 5;
const MAX_FILES = 8;
const MAX_FILE_CHARS = 20_000;
const INTERFACE_MAX_CHARS = 12_000;
const WRITER_MAX_TOKENS = 16_000;
const JUDGE_MAX_TOKENS = 8_000;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const SPEC_PATH = new RegExp(String.raw`^${SPEC_DIR}/(?!\.\.?$)[A-Za-z0-9_.-]+$`);

/** Numbered or bulleted lines in the goal: a rough count of its separate requirements. */
export function countRequirements(goal: string): number {
  return goal.split('\n').filter((l) => LIST_ITEM.test(l)).length;
}

/** Whether this goal gets spec tests: `on`, or `auto` for a big goal or one listing many rules. */
export function specTestsWanted(config: OmnexxConfig, goal: string, writing: boolean): boolean {
  const mode = config.review.spec_tests;
  if (mode === 'off' || writing) return false;
  if (mode === 'on') return true;
  return (
    goal.trim().length > config.plan.fast_max_goal_chars ||
    countRequirements(goal) >= MIN_REQUIREMENTS
  );
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb)$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);
const TEST_NAME = /[._-](?:test|spec)\./;
const CONTROL = /^(?:if|for|while|switch|catch|return|else|do|try|await|throw|new|typeof)\b/;
const DECLARATION =
  /^(?:export\s|module\.exports|exports\.|function\s|async\s|class\s|interface\s|type\s|def\s|pub\s|func\s)/;
const MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'async',
  'get',
  'set',
  'readonly',
]);
/** `name(` or `#name<T>(` at the start of a member header. */
const MEMBER_HEAD = /^#?[A-Za-z_$][\w$]*(?:<[^>]*>)?\(/;

function isTestFile(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((d) => TEST_DIRS.has(d)) ||
    TEST_NAME.test(name) ||
    (name.startsWith('test_') && name.endsWith('.py'))
  );
}

/** A method header inside a class or object body: `name(args) {`, `get name() {`. */
function isMember(line: string): boolean {
  if (!line.endsWith('{')) return false;
  const words = line.split(' ');
  let i = 0;
  while (i < words.length - 1 && MODIFIERS.has(words[i] ?? '')) i++;
  return MEMBER_HEAD.test(words.slice(i).join(' '));
}

/** Drop a trailing `{` (and `=> {`) from a header line. */
function header(line: string): string {
  const open = line.endsWith('{') ? line.slice(0, -1).trimEnd() : line;
  return open.endsWith('=>') ? `${open.slice(0, -2).trimEnd()} =>` : open;
}

/** One source line as a signature, or undefined when it is body. */
function signatureLine(raw: string): string | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('//') || line.startsWith('#') || CONTROL.test(line))
    return undefined;
  if (!DECLARATION.test(line) && !isMember(line)) return undefined;
  const indent = raw.length - raw.trimStart().length;
  return `${' '.repeat(Math.min(indent, 4))}${header(line)}`;
}

/**
 * The public interface of the changed source files: declarations and method headers, no bodies.
 * The spec-test writer must not see the implementation, or it would test what the code does
 * instead of what the goal asks.
 */
export function publicInterface(
  files: readonly { path: string; text: string }[],
  maxChars = INTERFACE_MAX_CHARS,
): string {
  const parts = files
    .filter((f) => CODE_FILE.test(f.path) && !isTestFile(f.path))
    .map((f) => {
      const sigs = f.text
        .split('\n')
        .map(signatureLine)
        .filter((l): l is string => l !== undefined);
      return sigs.length ? `## ${f.path}\n${sigs.join('\n')}` : '';
    })
    .filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [interface cut]` : text;
}

export const suiteSchema = z.object({
  command: z.string().min(3).max(300),
  files: z
    .array(
      z.object({
        path: z.string().regex(SPEC_PATH, `paths look like "${SPEC_DIR}/<name>"`),
        content: z.string().min(10).max(MAX_FILE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_FILES),
});
export type SpecSuite = z.infer<typeof suiteSchema>;

/** Validate the writer's answer: files only under SPEC_DIR, a one-line command that runs them. */
export function parseSuite(input: unknown): SpecSuite | string {
  if (typeof input !== 'object' || input === null) return 'no answer object';
  const o = input as { files?: unknown };
  // A writer that went over the file cap still wrote usable tests: keep the first ones.
  const files = Array.isArray(o.files) ? o.files.slice(0, MAX_FILES) : o.files;
  const r = suiteSchema.safeParse({ ...input, files });
  if (!r.success) return z.prettifyError(r.error).slice(0, 500);
  const command = r.data.command.trim();
  if (command.includes('\n')) return 'the command must be one line';
  if (!command.includes(SPEC_DIR)) return `the command must run the files under ${SPEC_DIR}/`;
  return { command, files: r.data.files };
}

const WRITER_SYSTEM = `You write independent acceptance tests for a coding task, from its specification alone. Another agent wrote the code; you never see its implementation, only the goal and the public interface (signatures).

Write tests that would catch a wrong reading of the spec:
- the boundaries of each rule (zero, exactly the limit, one past it, empty input) where the spec states the outcome;
- above all the interactions between requirements: one operation built on another (an operation that completes something an earlier call set up, an undo, a transfer, a save and restore), walked through a concrete call sequence. An internal step often wrongly re-runs a public check that its own earlier bookkeeping now fails.
Assert only what the spec states. Where it leaves a behaviour open, don't test it. Don't test internals, timing, messages or formatting the spec doesn't fix. Build every fixture only with calls the spec says succeed (a setup helper that passes a quantity of 0 where the spec requires a positive one breaks the test, not the code).

Use the project's own test runner and module style (see the project facts). Put every file under ${SPEC_DIR}/ at the repository root (one small file per requirement or interaction, import the code by a relative path from there), and give one shell command that runs only those files, naming each file (not a directory or glob), and exits non-zero when one fails. Reply only by calling the answer tool.`;

const WRITER_SHAPE = ` Call the answer tool with {"command": "<one line running each file>", "files": [{"path": "${SPEC_DIR}/<name>", "content": "<the test file>"}]}.`;

const JUDGE_SYSTEM = `You settle a dispute about acceptance tests. An independent model wrote tests from a specification; the agent that wrote the code says some of them contradict the specification. Decide for each disputed test file by the specification alone: drop it only when the test asserts something the spec contradicts or leaves open. A test that is right and code that is wrong means the test stays. Reply only by calling the answer tool.`;

const judgeSchema = z.object({
  drop: z.array(z.string().max(300)).max(MAX_FILES).default([]),
  reason: z.string().max(1_000).default(''),
});
export type DisputeVerdict = z.infer<typeof judgeSchema>;

async function askTool(
  run: Run,
  system: string,
  prompt: string,
  schema: z.ZodType,
  role: string,
  maxTokens: number,
): Promise<unknown> {
  const done = await run.cheapComplete(
    {
      system: [{ text: system }],
      tools: [
        { name: 'answer', description: 'Submit the answer', inputSchema: z.toJSONSchema(schema) },
      ],
      toolChoice: { type: 'tool', name: 'answer' },
      messages: [{ role: 'user', content: [{ type: 'text', text: run.redactor.text(prompt) }] }],
      maxTokens,
      messageBreakpoints: [],
    },
    {
      estimatedInputTokens: estimateTokens(prompt) + 800,
      maxOutputTokens: maxTokens,
      role,
      chain: run.config.review.spec_tests_models,
    },
  );
  const call = done?.res.content.find((b) => b.type === 'tool_use');
  return call?.type === 'tool_use' ? call.input : undefined;
}

export interface SpecContext {
  goal: string;
  intent: string;
  iface: string;
  /** Test commands, package.json scripts and module type: enough to pick the runner. */
  project: string;
}

/** One call: the suite, or undefined when the writer couldn't produce a usable one (fail open). */
export async function writeSpecSuite(run: Run, ctx: SpecContext): Promise<SpecSuite | undefined> {
  const prompt = [
    `# The specification (what the user asked for)\n${ctx.goal.slice(0, 8_000)}`,
    ...(ctx.intent ? [ctx.intent.slice(0, 3_000)] : []),
    `# Public interface (signatures only)\n${ctx.iface || '(none found: infer it from the spec)'}`,
    `# Project facts\n${ctx.project}`,
  ].join('\n\n');
  try {
    const ask = (text: string) =>
      askTool(run, WRITER_SYSTEM, text, suiteSchema, 'spec_tests', WRITER_MAX_TOKENS);
    const first = parseSuite(await ask(prompt));
    if (typeof first !== 'string') return first;
    // One retry with what was wrong: a model once answered with 22 tokens and no files.
    const second = parseSuite(
      await ask(`${prompt}\n\nYour last answer was unusable (${first}).${WRITER_SHAPE}`),
    );
    if (typeof second !== 'string') return second;
    run.events.emit('spec_tests.unavailable', { error: second });
    return undefined;
  } catch (err) {
    run.events.emit('spec_tests.unavailable', { error: (err as Error).message });
    return undefined;
  }
}

/** The judge's ruling on a dispute: which test files to drop. Undefined when it couldn't rule. */
export async function judgeDispute(
  run: Run,
  goal: string,
  suite: SpecSuite,
  failure: string,
  dispute: string,
): Promise<DisputeVerdict | undefined> {
  const tests = suite.files.map((f) => `## ${f.path}\n${f.content}`).join('\n\n');
  const prompt = [
    `# The specification\n${goal.slice(0, 8_000)}`,
    `# The acceptance tests\n${tests.slice(0, 24_000)}`,
    `# How they fail now\n${failure.slice(-4_000)}`,
    `# The coding agent's dispute\n${dispute.slice(0, 3_000)}`,
    'List in "drop" the paths of the test files to drop (none when every disputed test is right).',
  ].join('\n\n');
  try {
    const r = judgeSchema.safeParse(
      await askTool(run, JUDGE_SYSTEM, prompt, judgeSchema, 'spec_judge', JUDGE_MAX_TOKENS),
    );
    if (!r.success) return undefined;
    const known = new Set(suite.files.map((f) => f.path));
    const reason = r.data.reason.trim().length ? r.data.reason : 'no reason given';
    return { drop: r.data.drop.filter((p) => known.has(p)), reason };
  } catch (err) {
    run.events.emit('spec_tests.unavailable', { error: (err as Error).message });
    return undefined;
  }
}

/** Output that says the suite itself never ran: a runner that found no files, a bad command. */
const BROKEN =
  /no test files found|no tests? found|could not find|command not found|unknown (?:option|command)|ENOENT[^\n]*omnexx-spec|SyntaxError[^\n]*omnexx-spec/i;

export function suiteBroken(output: string): boolean {
  return BROKEN.test(output);
}
