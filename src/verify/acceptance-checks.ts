import { z } from 'zod';

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
    return `! grep -rn "${word}" --exclude="${excluded}" src/ test/`;
  }
  // Pattern: No file mentions `WORD`
  const noneMentions = /no file mentions `?([^`]+)`?/i.exec(c);
  if (noneMentions?.[1]) {
    const word = noneMentions[1].trim();
    return `! grep -rn "${word}" src/ test/`;
  }
  return undefined;
}

/** Extracts explicit export requirement checks from goal text (e.g. export class from module). */
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
  }
  return checks;
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
