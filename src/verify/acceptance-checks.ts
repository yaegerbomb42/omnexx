import { z } from 'zod';
import { shellQuote } from './shell-quote.js';

export interface PreflightCheck {
  id: string;
  description: string;
  command?: string;
  expectedOutcome?: string;
}

export const preflightCheckSchema = z.object({
  id: z.string(),
  description: z.string(),
  command: z.string().optional(),
  expectedOutcome: z.string().optional(),
});

export const preflightSuiteSchema = z.object({
  checks: z.array(preflightCheckSchema).min(1),
});

/** Converts standard acceptance criteria statements into executable shell checks where patterns are unambiguous. */
export function inferCheckCommand(criterion: string): string | undefined {
  const c = criterion.trim();
  // Pattern: `COMMAND` passes with tests (requires test suite not to be empty 0 tests)
  const cmdPassTests = /^`([^`]+)`\s+passes\s+with\s+tests/i.exec(c);
  if (cmdPassTests?.[1]) {
    const cmd = cmdPassTests[1].trim();
    return `${cmd} && ! (${cmd} 2>&1 | grep -q 'ℹ tests 0')`;
  }
  // Pattern: `COMMAND` passes
  const cmdPass = /^`([^`]+)`\s+passes/i.exec(c);
  if (cmdPass?.[1]) {
    return cmdPass[1].trim();
  }
  // Pattern: No file other than `PATH` mentions `WORD`
  const noOther = /no file other than `?([^`]+)`? mentions `?([^`]+)`?/i.exec(c);
  if (noOther?.[1] && noOther[2]) {
    const excluded = noOther[1].trim();
    const word = noOther[2].trim();
    return `! grep -rn ${shellQuote(word)} --exclude=${shellQuote(excluded)} src/ test/`;
  }
  // Pattern: No file mentions `WORD`
  const noneMentions = /no file mentions `?([^`]+)`?/i.exec(c);
  if (noneMentions?.[1]) {
    const word = noneMentions[1].trim();
    return `! grep -rn ${shellQuote(word)} src/ test/`;
  }
  return undefined;
}

/** Extracts explicit export and function requirement checks from goal text (e.g. export class from module, add func to module). */
export function inferGoalChecks(goal: string): string[] {
  const checks: string[] = [];
  const pSym = /throws\s+a\s+`([A-Za-z0-9_$]+)`/i;
  const pExp = /(?:export\s+(?:the\s+class\s+|the\s+function\s+)?from\s+`([^`]+)`)/i;
  const mSym = pSym.exec(goal);
  const mExp = pExp.exec(goal);
  if (mSym?.[1] && mExp?.[1]) {
    const symbol = mSym[1];
    const file = mExp[1].replace(/^\.?\//, '');
    checks.push(`node --input-type=module -e 'import { ${symbol} } from "./${file}"'`);

    // Pattern: throws ValidationError naming bad field: `field1`: ..., `field2`: ...
    // Extract bulleted field names and property identifiers mentioned in the goal
    const fields: string[] = [];
    for (const fb of goal.matchAll(/-\s+`([A-Za-z0-9_$]+)`\s*(?:\([^)]*\))?:/gi)) {
      if (fb[1]) fields.push(fb[1]);
    }
    for (const m of goal.matchAll(/`([A-Za-z0-9_$]+)`/g)) {
      const sym = m[1];
      if (
        sym &&
        !fields.includes(sym) &&
        !['ValidationError', 'createOrder', 'orders.js', 'npm', 'test', 'field'].includes(sym) &&
        !sym.endsWith('.js') &&
        !sym.endsWith('.ts')
      ) {
        fields.push(sym);
      }
    }
    if (fields.length > 0) {
      const fieldList = fields.map((f) => `"${f}"`).join(', ');
      checks.push(
        `node --input-type=module -e 'import { ${symbol} } from "./${file}"; for (const f of [${fieldList}]) { const e = new ${symbol}(f); if (e.field !== f) process.exit(1); }'`,
      );
    }
  }

  // Pattern: Add `func(args)` to `path/to/file`
  for (const m of goal.matchAll(
    /(?:add|export)\s+`([A-Za-z0-9_$]+)(?:\([^`]*\))?`\s+to\s+`([^`]+)`/gi,
  )) {
    const symbol = m[1];
    const file = m[2]?.replace(/^\.?\//, '');
    if (symbol && file) {
      checks.push(`node --input-type=module -e 'import { ${symbol} } from "./${file}"'`);
    }
  }

  // Pattern: Use `func` in `path/to/file` or use `func` from `./module`
  for (const m of goal.matchAll(/use\s+(?:it\s+in\s+|`([A-Za-z0-9_$]+)`\s+in\s+)`([^`]+)`/gi)) {
    const file = m[2]?.replace(/^\.?\//, '');
    if (file) {
      checks.push(`node --input-type=module -e 'import "./${file}"'`);
    }
  }

  // Pattern: so `func(args)` returns CSV with a header row `a,b,c`
  const pCsvExport =
    /`([A-Za-z0-9_$]+)\([^`]*\)`\s+returns\s+CSV\s+with\s+a\s+header\s+row\s+`([^`]+)`/i.exec(goal);
  if (pCsvExport?.[1] && pCsvExport[2]) {
    const fn = pCsvExport[1];
    const header = pCsvExport[2];
    // Find the module where this function is exported: in `path/to/file` so `func(...)`
    const pModBefore = new RegExp(
      `(?:in|to)\\s+\`([^\`]+\\.[cm]?[jt]sx?)\`\\s+so\\s+\`${fn}`,
      'i',
    ).exec(goal);
    const mod = (pModBefore?.[1] ?? '').replace(/^\.?\//, '');
    if (mod) {
      checks.push(
        `node --input-type=module -e 'import { ${fn} } from "./${mod}"; const r = ${fn}([]); if (!r.startsWith("${header}")) process.exit(1);'`,
      );
    }
  }

  return Array.from(new Set(checks));
}

/**
 * Builds deterministic pre-flight acceptance check definitions before an improvement round begins,
 * ensuring each task has explicit verification gates before execution.
 */
export function buildPreflightChecks(task: {
  id: string;
  title: string;
  requirements?: readonly string[];
}): PreflightCheck[] {
  const reqs = task.requirements && task.requirements.length > 0 ? task.requirements : [task.title];
  return reqs.map((req, idx) => {
    const command = inferCheckCommand(req);
    return {
      id: `${task.id}-check-${idx + 1}`,
      description: `Verify requirement: ${req}`,
      ...(command ? { command } : {}),
    };
  });
}
