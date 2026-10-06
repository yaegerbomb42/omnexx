import { z } from 'zod';
import { readTextOr, writeFileAtomic } from '../core/atomic.js';
import type { RunStore } from '../core/run-store.js';
import { ok, type Tool } from '../tools/types.js';

export const INTENT_FILE = 'intent.md';

/** What the user actually wants, inferred once from a short prompt and the repo. */
export const intentSchema = z.strictObject({
  product: z.string().min(10).max(1_200).describe('The end result the user wants, concretely'),
  users: z.string().max(400).default('').describe('Who uses it and how'),
  done: z
    .array(z.string().min(3).max(300))
    .min(1)
    .max(15)
    .describe('Observable conditions that mean the build is complete'),
  assumptions: z
    .array(z.string().min(3).max(300))
    .max(15)
    .default([])
    .describe('Decisions you made where the prompt was ambiguous (the user can steer these)'),
  checks: z
    .array(z.string().min(3).max(300))
    .max(15)
    .default([])
    .describe('Tests or commands you will add so that "done" is machine-checkable'),
});
export type Intent = z.infer<typeof intentSchema>;

export function renderIntent(i: Intent): string {
  const list = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join('\n');
  return [
    `# Inferred intent\n\n${i.product.trim()}`,
    i.users ? `## Users\n\n${i.users.trim()}` : '',
    `## Done when\n\n${list(i.done)}`,
    i.assumptions.length ? `## Assumptions (steer to change)\n\n${list(i.assumptions)}` : '',
    i.checks.length ? `## Checks to add\n\n${list(i.checks)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function readIntent(store: RunStore): Promise<string> {
  return (await readTextOr(store.file(INTENT_FILE), '')).trim();
}

/** Planner-only tool (initial planning): record the inferred intent as intent.md in the run dir. */
export function writeIntentTool(
  store: RunStore,
  onWrite: (i: Intent) => void,
): Tool<typeof intentSchema> {
  return {
    name: 'write_intent',
    description:
      'Record what the user actually wants: the product, its users, observable "done" conditions, the assumptions you made, and the checks you will add. Call once, before write_plan.',
    schema: intentSchema,
    readOnly: true,
    async run(input) {
      await writeFileAtomic(store.file(INTENT_FILE), `${renderIntent(input)}\n`);
      onWrite(input);
      return ok('intent recorded; now call write_plan, putting a working, checkable v1 first');
    },
  };
}
