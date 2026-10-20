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
  return reqs.map((req, idx) => ({
    id: `${task.id}-check-${idx + 1}`,
    description: `Verify requirement: ${req}`,
  }));
}
