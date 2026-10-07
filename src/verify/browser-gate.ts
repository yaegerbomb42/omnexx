import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { createBrowserBackend } from '../tools/extra/browser/detector.js';
import type { BrowserBackend } from '../tools/extra/browser/types.js';
import type { GateResult, GateRunContext } from './gates.js';
import type { Failure, TestCounts } from './parsers/types.js';

export const browserStepSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    url: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal('click'),
    selector: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal('type'),
    selector: z.string().min(1),
    text: z.string(),
  }),
  z.strictObject({
    action: z.literal('expect_text'),
    text: z.string(),
    selector: z.string().optional(),
  }),
  z.strictObject({
    action: z.literal('expect_selector'),
    selector: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal('expect_no_console_errors'),
  }),
  /** The page rendered something: its accessibility snapshot is more than a bare shell. */
  z.strictObject({
    action: z.literal('expect_nonempty'),
  }),
  z.strictObject({
    action: z.literal('fill'),
    selector: z.string().min(1),
    text: z.string(),
  }),
  z.strictObject({
    action: z.literal('select'),
    selector: z.string().min(1),
    value: z.string(),
  }),
  /** Waits for an element or for text; give exactly one of `selector` or `text`. */
  z
    .strictObject({
      action: z.literal('wait_for'),
      selector: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .refine((s) => (s.selector === undefined) !== (s.text === undefined), {
      message: 'wait_for needs exactly one of selector or text',
    }),
  /** The current URL contains `url` (after `${URL}` substitution). */
  z.strictObject({
    action: z.literal('expect_url'),
    url: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal('wait_ms'),
    ms: z.number().int().nonnegative(),
  }),
]);

export type BrowserStep = z.infer<typeof browserStepSchema>;

export const browserGateFileSchema = z.strictObject({
  name: z.string().optional(),
  steps: z.array(browserStepSchema),
});

export type BrowserGateFile = z.infer<typeof browserGateFileSchema>;

export interface BrowserGateConfig {
  name: string;
  kind?: 'browser';
  /** Steps file relative to cwd; without one the gate runs DEFAULT_STEPS against `url`. */
  script?: string | undefined;
  /** Replaces `${URL}` in step URLs (set when the gate serves the app itself). */
  url?: string | undefined;
  level?: 'must-pass' | 'ratchet';
  timeout?: string;
}

/**
 * Parses YAML or TOML browser gate definition files.
 * Supports standard YAML key-value / list syntax without external YAML dependencies,
 * or TOML definitions via smol-toml.
 */
export function parseBrowserGateScript(raw: string): BrowserGateFile {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('[[')) {
    // Attempt TOML / JSON parse
    try {
      const parsed = parseToml(trimmed);
      return browserGateFileSchema.parse(parsed);
    } catch {
      // Fall through to YAML parse
    }
  }

  // Parse YAML / TOML steps
  try {
    const parsed = parseSimpleYaml(raw);
    return browserGateFileSchema.parse(parsed);
  } catch (err) {
    try {
      const parsed = parseToml(raw);
      return browserGateFileSchema.parse(parsed);
    } catch {
      throw new Error(
        `Failed to parse browser gate script: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Lightweight YAML parser tailored for list-of-steps and simple key-value structures.
 */
export function parseSimpleYaml(raw: string): Record<string, unknown> {
  const lines = raw.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey = '';
  let inList = false;
  const listItems: Record<string, unknown>[] = [];
  let currentItem: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ')) {
      inList = true;
      if (currentItem) {
        listItems.push(currentItem);
      }
      currentItem = {};
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const colonIdx = rest.indexOf(':');
        if (colonIdx > 0) {
          const k = rest.slice(0, colonIdx).trim();
          const v = parseYamlScalar(rest.slice(colonIdx + 1).trim());
          currentItem[k] = v;
        }
      }
      continue;
    }

    if (inList && (line.startsWith('    ') || line.startsWith('  '))) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0 && currentItem) {
        const k = trimmed.slice(0, colonIdx).trim();
        const v = parseYamlScalar(trimmed.slice(colonIdx + 1).trim());
        currentItem[k] = v;
      }
      continue;
    }

    // Top-level key
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      if (inList && currentKey) {
        if (currentItem) listItems.push(currentItem);
        result[currentKey] = listItems;
        inList = false;
      }
      const k = trimmed.slice(0, colonIdx).trim();
      const v = trimmed.slice(colonIdx + 1).trim();
      currentKey = k;
      if (v) {
        result[k] = parseYamlScalar(v);
      }
    }
  }

  if (inList && currentKey) {
    if (currentItem) listItems.push(currentItem);
    result[currentKey] = listItems;
  }

  return result;
}

function parseYamlScalar(val: string): unknown {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/** Smoke check when a gate has no script: it loads, renders something, and logs no errors. */
export const DEFAULT_STEPS: BrowserStep[] = [
  { action: 'open', url: '${URL}' },
  { action: 'wait_ms', ms: 500 },
  { action: 'expect_nonempty' },
  { action: 'expect_no_console_errors' },
];

const DEFAULT_WAIT_MS = 10_000;

/** Snapshots shorter than this are an empty or blank page. */
const MIN_SNAPSHOT_CHARS = 40;

const unsupported = (backend: BrowserBackend, action: string): Error =>
  new Error(`the ${backend.name} browser backend does not support "${action}"`);

export async function runBrowserGate(
  gate: BrowserGateConfig,
  ctx: GateRunContext,
  customBackend?: BrowserBackend,
): Promise<GateResult> {
  const logFile = join(ctx.logsDir, `gate-${ctx.label}-${gate.name}.log`);
  const startTime = Date.now();
  const logLines: string[] = [`Running browser gate "${gate.name}" from ${gate.script}`];

  let parsedFile: BrowserGateFile;
  if (gate.script === undefined) {
    parsedFile = { steps: DEFAULT_STEPS };
    logLines[0] = `Running browser gate "${gate.name}" (default smoke steps)`;
  } else {
    const scriptPath = join(ctx.cwd, gate.script);
    let rawScript: string;
    try {
      rawScript = await readFile(scriptPath, 'utf8');
    } catch (err) {
      const msg = `Cannot read gate script "${scriptPath}": ${err instanceof Error ? err.message : String(err)}`;
      await writeFile(logFile, `${msg}\n`, { mode: 0o600 }).catch(() => undefined);
      return {
        name: gate.name,
        level: gate.level ?? 'ratchet',
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        failures: [{ id: `${gate.name}:missing_script`, message: msg }],
        structured: true,
        logFile,
      };
    }

    try {
      parsedFile = parseBrowserGateScript(rawScript);
    } catch (err) {
      const msg = `Invalid gate script "${gate.script}": ${err instanceof Error ? err.message : String(err)}`;
      await writeFile(logFile, `${msg}\n`, { mode: 0o600 }).catch(() => undefined);
      return {
        name: gate.name,
        level: gate.level ?? 'ratchet',
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        failures: [{ id: `${gate.name}:syntax_error`, message: msg }],
        structured: true,
        logFile,
      };
    }
  }

  const sessionName = `omnexx-gate-${gate.name}-${Date.now()}`;
  const backend = customBackend ?? (await createBrowserBackend(sessionName, true));
  if (!backend) {
    const msg =
      'No browser backend available (agent-browser or playwright-core) to execute browser gate.';
    await writeFile(logFile, `${msg}\n`, { mode: 0o600 }).catch(() => undefined);
    return {
      name: gate.name,
      level: gate.level ?? 'ratchet',
      exitCode: 1,
      timedOut: false,
      durationMs: Date.now() - startTime,
      failures: [{ id: `${gate.name}:no_backend`, message: msg }],
      structured: true,
      logFile,
    };
  }

  const failures: Failure[] = [];
  let passedCount = 0;
  const totalSteps = parsedFile.steps.length;

  try {
    for (let i = 0; i < parsedFile.steps.length; i++) {
      const step = parsedFile.steps[i];
      if (!step) continue;
      logLines.push(`Step ${i + 1}: ${step.action}`);

      try {
        switch (step.action) {
          case 'open': {
            await backend.open(step.url.replaceAll('${URL}', gate.url ?? ''));
            passedCount++;
            break;
          }

          case 'click': {
            await backend.click(step.selector);
            passedCount++;
            break;
          }

          case 'type': {
            await backend.type(step.selector, step.text);
            passedCount++;
            break;
          }

          case 'fill': {
            if (!backend.fill) throw unsupported(backend, step.action);
            await backend.fill(step.selector, step.text);
            passedCount++;
            break;
          }

          case 'select': {
            if (!backend.select) throw unsupported(backend, step.action);
            await backend.select(step.selector, step.value);
            passedCount++;
            break;
          }

          case 'wait_for': {
            if (!backend.waitFor) throw unsupported(backend, step.action);
            const target =
              step.selector !== undefined ? { selector: step.selector } : { text: step.text ?? '' };
            await backend.waitFor(target, step.timeout_ms ?? DEFAULT_WAIT_MS);
            passedCount++;
            break;
          }

          case 'expect_url': {
            if (!backend.getUrl) throw unsupported(backend, step.action);
            const want = step.url.replaceAll('${URL}', gate.url ?? '');
            const got = await backend.getUrl();
            if (!got.includes(want)) {
              throw new Error(`Expected URL containing "${want}", but the page is at "${got}"`);
            }
            passedCount++;
            break;
          }

          case 'wait_ms': {
            await new Promise((r) => setTimeout(r, step.ms));
            passedCount++;
            break;
          }

          case 'expect_text': {
            const snapshot = await backend.snapshot();
            if (!snapshot.includes(step.text)) {
              throw new Error(`Expected text "${step.text}" not found in snapshot`);
            }
            passedCount++;
            break;
          }

          case 'expect_selector': {
            // Check snapshot for selector/ref presence
            const snapshot = await backend.snapshot();
            const target = step.selector.startsWith('@')
              ? step.selector
              : step.selector.replace(/^[#.[\]]/, '');
            if (!snapshot.includes(target) && !snapshot.includes(step.selector)) {
              throw new Error(`Expected element matching "${step.selector}" not found`);
            }
            passedCount++;
            break;
          }

          case 'expect_nonempty': {
            const snapshot = await backend.snapshot();
            if (snapshot.trim().length < MIN_SNAPSHOT_CHARS) {
              throw new Error(`Page looks empty (snapshot: ${JSON.stringify(snapshot.trim())})`);
            }
            passedCount++;
            break;
          }

          case 'expect_no_console_errors': {
            const logs = await backend.console();
            const errors = logs.filter((l) => l.type === 'error');
            if (errors.length > 0) {
              const details = errors.map((e) => e.text).join('; ');
              throw new Error(`Expected no console errors, but found ${errors.length}: ${details}`);
            }
            passedCount++;
            break;
          }
        }
      } catch (stepErr) {
        const errorMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
        logLines.push(`  FAILED: ${errorMsg}`);
        failures.push({
          id: `${gate.name}:step_${i + 1}_${step.action}`,
          message: `Step ${i + 1} (${step.action}) failed: ${errorMsg}`,
        });
        break; // Stop running further steps in this gate script
      }
    }
  } finally {
    await backend.close().catch(() => undefined);
  }

  const durationMs = Date.now() - startTime;
  const exitCode = failures.length === 0 ? 0 : 1;
  const tests: TestCounts = {
    total: totalSteps,
    passed: passedCount,
    failed: failures.length,
    skipped: Math.max(0, totalSteps - passedCount - failures.length),
  };

  logLines.push(
    `Gate ${gate.name} finished with exitCode ${exitCode} (${passedCount}/${totalSteps} passed) in ${durationMs}ms`,
  );
  await writeFile(logFile, logLines.join('\n') + '\n', { mode: 0o600 }).catch(() => undefined);

  return {
    name: gate.name,
    level: gate.level ?? 'ratchet',
    exitCode,
    timedOut: false,
    durationMs,
    failures,
    tests,
    structured: true,
    logFile,
  };
}
