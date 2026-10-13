import { join } from 'node:path';
import { z } from 'zod';
import { readTextOr, writeFileAtomic } from '../core/atomic.js';
import type { PlanNode } from '../core/plan.js';
import type { RunStore } from '../core/run-store.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Context sections and how each reaches the model. Pinned: in every request, as before.
 * Optional: listed in a short table of contents and pulled in with the `context` tool only when
 * the agent needs it. Hidden: never sent. The person sets the modes ([context.sections] or the
 * editor's Context explorer); omnexx keeps managing what goes inside each section.
 */
export const SECTION_IDS = ['role', 'codemap', 'intent', 'lessons', 'progress'] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const SECTION_MODES = ['pinned', 'optional', 'hidden'] as const;
export type SectionMode = (typeof SECTION_MODES)[number];

export const sectionsSchema = z
  .strictObject({
    role: z.enum(SECTION_MODES).default('pinned'),
    /** The biggest section (~3k tokens) and the one most steps don't need. */
    codemap: z.enum(SECTION_MODES).default('optional'),
    intent: z.enum(SECTION_MODES).default('pinned'),
    lessons: z.enum(SECTION_MODES).default('pinned'),
    progress: z.enum(SECTION_MODES).default('pinned'),
  })
  .prefault({});
export type SectionModes = z.infer<typeof sectionsSchema>;

/** What each section holds and which `context` scope opens it. */
export const SECTION_INFO: Record<SectionId, { label: string; about: string; scope: string }> = {
  role: {
    label: 'Role card',
    about: 'your role and what done means for this task',
    scope: 'recent',
  },
  codemap: { label: 'Codebase map', about: 'files and their main symbols', scope: 'repo' },
  intent: { label: 'Intent', about: 'what the finished product should be', scope: 'general' },
  lessons: {
    label: 'Lessons',
    about: 'gotchas and conventions from earlier cycles',
    scope: 'general',
  },
  progress: { label: 'Progress', about: 'what the last cycles did', scope: 'recent' },
};

/** The table of contents for optional sections, with their sizes so the agent can judge the cost. */
export function contentsBlock(optional: readonly { id: SectionId; text: string }[]): string {
  if (!optional.length) return '';
  const rows = optional.map((s) => {
    const info = SECTION_INFO[s.id];
    return `- ${info.label}: ${info.about} (~${String(estimateTokens(s.text))} tokens) → context read scope="${info.scope}"`;
  });
  return `# More context, when you need it\n\nNot loaded, to keep each step lean. Open a section only if it helps this step:\n${rows.join('\n')}`;
}

const ROLE_BY_KIND: Record<string, { title: string; focus: string }> = {
  feature: {
    title: 'Implementer',
    focus: 'Build the behaviour end to end, with tests that prove it, in small verified steps.',
  },
  tests: {
    title: 'Test engineer',
    focus:
      'Write tests that pin down the real behaviour, including edge cases; never weaken tests to pass.',
  },
  refactor: {
    title: 'Refactorer',
    focus:
      'Change structure, not behaviour: keep every test green and the public surface the same.',
  },
  lint: {
    title: 'Code hygienist',
    focus: 'Fix the warnings at their cause; never silence a rule.',
  },
  migration: {
    title: 'Migrator',
    focus: 'Move things over in steps that each keep the build working; keep data safe.',
  },
  docs: {
    title: 'Technical writer',
    focus: 'Write what a reader needs to use it, checked against the code as it is now.',
  },
  investigate: {
    title: 'Investigator',
    focus: 'Find the cause with evidence before changing anything; write down what you learn.',
  },
};

const IMPLEMENTER = {
  title: 'Implementer',
  focus: 'Build the behaviour end to end, with tests that prove it, in small verified steps.',
};

/** The generated role card for a task: who the agent is for it and what done means. */
export function roleCard(task: PlanNode): string {
  const role = ROLE_BY_KIND[task.kind] ?? IMPLEMENTER;
  const lines = [
    `# Role: ${role.title} for ${task.id}`,
    '',
    `Task: ${task.title}`,
    task.why ? `Why it matters: ${task.why}` : '',
    '',
    role.focus,
  ];
  if (task.acceptance.length) lines.push('', 'Done when:', ...task.acceptance.map((a) => `- ${a}`));
  if (task.checks.length)
    lines.push('', 'The harness checks:', ...task.checks.map((c) => `- \`${c}\``));
  return `${lines
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n')
    .trim()}\n`;
}

const roleFile = (store: RunStore, taskId: string): string =>
  store.file(join('roles', `${taskId}.md`));

/**
 * The role card for this task: the person's edited copy if there is one, else a fresh one written
 * to the run folder (so it can be opened and edited), plus the repo's own `.omnexx/role.md`.
 */
export async function loadRoleCard(
  store: RunStore,
  task: PlanNode,
  repoRoot: string,
): Promise<string> {
  const file = roleFile(store, task.id);
  let card = await readTextOr(file, '');
  if (!card.trim()) {
    card = roleCard(task);
    await writeFileAtomic(file, card);
  }
  const extra = (await readTextOr(join(repoRoot, '.omnexx', 'role.md'), '')).trim();
  return extra ? `${card.trim()}\n\n## For this repository\n\n${extra}\n` : card;
}
