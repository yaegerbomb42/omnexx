import type { SweBenchConfig } from '../config/sections/swe-bench.js';
import type { Run } from '../core/run.js';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { estimateTokens } from '../core/tokens.js';
import { z } from 'zod';
import { publicInterface } from '../verify/spec-tests.js';
import type { LocalizationResult } from './localize.js';

const exec = promisify(execCb);

/**
 * Bug reproduction test harness for SWE-bench-style tasks.
 *
 * A reproduction test:
 * 1. Is written by a model that sees only the issue and public interface
 * 2. Must FAIL on the original (buggy) tree
 * 3. Must PASS after the fix is applied
 * 4. Lives outside the repo (in run store) while running
 */

export const REPRO_DIR = 'omnexx-repro';
const REPRO_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 4_000;

export interface ReproTest {
  command: string;
  files: { path: string; content: string }[];
}

export interface ReproResult {
  pass: boolean;
  output: string;
  exitCode: number | null;
}

const reproSchema = z.object({
  command: z.string().min(3).max(300),
  files: z
    .array(
      z.object({
        path: z.string().regex(new RegExp(`^${REPRO_DIR}/[A-Za-z0-9_.-]+$`)),
        content: z.string().min(10).max(20_000),
      }),
    )
    .min(1)
    .max(3),
});

const REPRO_SYSTEM = `You write a minimal reproduction test for a bug report. The test must:
1. FAIL on the current (buggy) code
2. PASS after the fix is applied
3. Test only the specific behavior described in the issue
4. Use the project's test framework (infer from the project facts)
5. Put all files under ${REPRO_DIR}/ at the repository root
6. Give one shell command that runs the test and exits non-zero on failure

Do NOT:
- Test unrelated functionality
- Make assertions about implementation details
- Include timing-dependent tests
- Test error messages unless the issue specifically mentions them

Reply only by calling the answer tool.`;

/**
 * Context for reproduction test generation.
 */
export interface ReproContext {
  issue: string;
  iface: string;
  project: string;
  localization: LocalizationResult;
}

/**
 * Build a prompt for reproduction test generation.
 */
function buildReproPrompt(ctx: ReproContext): string {
  const sections: string[] = [];

  sections.push('# Bug Report');
  sections.push(ctx.issue.slice(0, 8_000));
  sections.push('');

  if (ctx.localization.elements.length > 0) {
    sections.push('# Suspect Code Locations');
    for (const el of ctx.localization.elements.slice(0, 5)) {
      sections.push(`- ${el.file}:${el.startLine} ${el.kind} ${el.name}`);
    }
    sections.push('');
  }

  sections.push('# Public Interface (signatures only)');
  sections.push(ctx.iface || '(infer from the issue)');
  sections.push('');

  sections.push('# Project Facts');
  sections.push(ctx.project);

  return sections.join('\n');
}

/**
 * Parse the model's reproduction test output.
 */
export function parseReproTest(input: unknown): ReproTest | string {
  if (typeof input !== 'object' || input === null) return 'no answer object';
  const result = reproSchema.safeParse(input);
  if (!result.success) return z.prettifyError(result.error).slice(0, 500);

  const command = result.data.command.trim();
  if (command.includes('\n')) return 'command must be one line';
  if (!command.includes(REPRO_DIR)) return `command must run files under ${REPRO_DIR}/`;

  return { command, files: result.data.files };
}

/**
 * Generate a reproduction test using the LLM.
 */
export async function generateReproTest(
  run: Run,
  ctx: ReproContext,
  config: SweBenchConfig,
): Promise<ReproTest | undefined> {
  const prompt = buildReproPrompt(ctx);

  for (let attempt = 0; attempt < config.reproduction_max_attempts; attempt++) {
    try {
      const done = await run.cheapComplete(
        {
          system: [{ text: REPRO_SYSTEM }],
          tools: [
            {
              name: 'answer',
              description: 'Submit the reproduction test',
              inputSchema: z.toJSONSchema(reproSchema),
            },
          ],
          toolChoice: { type: 'tool', name: 'answer' },
          messages: [
            { role: 'user', content: [{ type: 'text', text: run.redactor.text(prompt) }] },
          ],
          maxTokens: 8_000,
          messageBreakpoints: [],
        },
        {
          estimatedInputTokens: estimateTokens(prompt) + 800,
          maxOutputTokens: 8_000,
          role: 'repro_test',
          purpose: 'verification',
          chain: config.reproduction_models,
        },
      );

      const call = done?.res.content.find((b) => b.type === 'tool_use');
      if (call?.type !== 'tool_use') continue;

      const parsed = parseReproTest(call.input);
      if (typeof parsed === 'string') {
        run.events.emit('repro_test.retry', { attempt, error: parsed });
        continue;
      }

      return parsed;
    } catch (err) {
      run.events.emit('repro_test.error', { attempt, error: (err as Error).message });
    }
  }

  run.events.emit('repro_test.unavailable', {});
  return undefined;
}

/**
 * Write reproduction test files to the worktree.
 */
export async function writeReproTest(worktree: string, test: ReproTest): Promise<void> {
  const reproDir = join(worktree, REPRO_DIR);
  await rm(reproDir, { recursive: true, force: true });
  await mkdir(reproDir, { recursive: true });

  for (const file of test.files) {
    const fullPath = join(worktree, file.path);
    await writeFile(fullPath, file.content, 'utf8');
  }
}

/**
 * Remove reproduction test files from the worktree.
 */
export async function cleanReproTest(worktree: string): Promise<void> {
  const reproDir = join(worktree, REPRO_DIR);
  await rm(reproDir, { recursive: true, force: true });
}

/**
 * Run the reproduction test and return the result.
 */
export async function runReproTest(
  worktree: string,
  test: ReproTest,
  env: Record<string, string>,
): Promise<ReproResult> {
  try {
    const { stdout, stderr } = await exec(test.command, {
      cwd: worktree,
      timeout: REPRO_TIMEOUT_MS,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS);
    return { pass: true, output, exitCode: 0 };
  } catch (err) {
    const error = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').slice(-MAX_OUTPUT_CHARS);
    const exitCode = error.killed ? null : (error.code ?? 1);
    return { pass: false, output, exitCode };
  }
}

/**
 * Validate that the reproduction test fails on the original tree.
 * This confirms it's actually reproducing the bug.
 */
export async function validateReproFails(
  worktree: string,
  test: ReproTest,
  env: Record<string, string>,
): Promise<{ valid: boolean; result: ReproResult }> {
  await writeReproTest(worktree, test);
  const result = await runReproTest(worktree, test, env);

  const valid = !result.pass;
  return { valid, result };
}

/**
 * Build interface text from localized files for reproduction context.
 */
export async function buildReproInterface(
  worktree: string,
  localization: LocalizationResult,
): Promise<string> {
  const files: { path: string; text: string }[] = [];

  for (const loc of localization.lines.slice(0, 5)) {
    try {
      const text = await readFile(join(worktree, loc.file), 'utf8');
      files.push({ path: loc.file, text });
    } catch {
      continue;
    }
  }

  return publicInterface(files);
}
