import type { OmnexxConfig } from '../config/schema.js';

/**
 * Writing runs: the goal is prose (a book, a report, a research document), not code. There are
 * no tests to pass, so the plan's checks are mechanical (the file exists, enough words, no
 * placeholders) and a reviewer reading for writing quality is the gate. Each chapter gets a
 * one-line summary in the map, and the agent keeps a bible (names, facts, style, open threads)
 * in its general notes, so a long manuscript stays consistent across hundreds of cycles.
 */
const WRITE_VERBS = ['write', 'draft', 'author', 'compose', 'research', 'outline'];
const PROSE_WORDS = [
  'book',
  'novel',
  'novella',
  'story',
  'stories',
  'essay',
  'article',
  'report',
  'paper',
  'thesis',
  'dissertation',
  'guide',
  'handbook',
  'manual',
  'whitepaper',
  'document',
  'chapter',
  'chapters',
  'screenplay',
  'script',
  'blog',
  'newsletter',
  'memoir',
  'biography',
  'curriculum',
  'course',
];
const CODE_WORDS = [
  'function',
  'class',
  'api',
  'endpoint',
  'bug',
  'refactor',
  'test',
  'tests',
  'testing',
  'compile',
  'typescript',
  'javascript',
  'python',
  'component',
  'database',
  'deploy',
];
const CODE_PATH = /src\/|\.(?:ts|js|py)\b/i;

export function isWritingGoal(goal: string): boolean {
  const head = goal.slice(0, 2_000);
  const words = new Set(head.toLowerCase().match(/[a-z]+/g) ?? []);
  const has = (list: readonly string[]): boolean => list.some((w) => words.has(w));
  return has(WRITE_VERBS) && has(PROSE_WORDS) && !has(CODE_WORDS) && !CODE_PATH.test(head);
}

/** The run is a writing run: set explicitly, or detected from the goal in auto. */
export function resolveWriting(config: OmnexxConfig, goal: string): boolean {
  if (config.plan.kind === 'writing') return true;
  if (config.plan.kind === 'code') return false;
  return isWritingGoal(goal);
}

export const WRITING_PLANNER_NOTE = `This is a writing run: the deliverable is prose, not code, and there are no tests. Plan it like an author with an editor:
- M1 is the foundation: an outline file (every part and chapter or section, one paragraph each) and a bible file (premise or thesis, audience, voice and style rules, names and facts, open threads). Later tasks follow them.
- Then one milestone per part or group of chapters, and one task per chapter or section, kind "writing" (kind "research" for gathering sources and notes, with every claim cited). Each task writes one file under a clear folder (e.g. book/03-the-storm.md), in full.
- Checks are mechanical and must fail before the task is done: the file exists, a minimum word count, and no placeholder text, e.g. \`test -f book/03-the-storm.md && test "$(wc -w < book/03-the-storm.md)" -ge 2500 && ! grep -qiE 'TODO|TBD|lorem ipsum|\\[insert' book/03-the-storm.md\`. Set the word counts from the outline's sense of length.
- Size tasks so one cycle can write them well (about 1,500 to 4,000 words each). Expand later milestones when reached; the last milestone joins the parts (table of contents, a combined file if the goal asks for one).
- Combine or copy files with a shell command in the task's steps (\`cat book/0*.md > book/manuscript.md\`), never by retyping them: retyped text drifts and costs a cycle per chapter.
- No separate "consistency report" or "fix mismatches" tasks: every piece is already reviewed against the bible before it is kept.`;

export const WRITING_REVIEW_SYSTEM = `You are an exacting editor reviewing one piece of an ongoing manuscript before it is kept. You get the task, the goal and the diff.

Report only real problems, each with a severity:
- blocker: placeholder or summary where the full text was needed; contradicts the outline, the bible or earlier chapters (names, facts, timeline, argument); clearly off the task or the goal; far shorter than the task asks; for research, claims presented as fact with no source.
- major: a scene or argument that doesn't work (no point, no progression); a voice clearly different from the bible's style rules.
- minor: anything smaller (word choice, rhythm).
A blocker needs evidence: quote the line and name what it contradicts or lacks. Taste is minor at most. If the piece is sound, return no findings. Reply only by calling the answer tool.`;

/** Codemap purposes for prose: what each file covers, so the map reads as a table of contents. */
export const WRITING_DESCRIBE_PROMPT =
  'Write a one-line summary (max 25 words) of what each file covers: for a chapter, what happens or what it argues. Reply only by calling the answer tool.';
