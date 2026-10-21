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
