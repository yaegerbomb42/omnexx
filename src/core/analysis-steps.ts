import type { Message } from '../providers/types.js';
import type { TodoItem } from '../tools/todo.js';

/** The longest todo text the todo tool accepts. */
const ITEM_CHARS = 200;
const MAX_STEPS = 12;

const STEPS_HEADING =
  /^\s*(?:#+\s*)?(?:\*\*)?\s*(?:\d+[.)]\s*)?(?:\*\*)?\s*(?:ordered\s+)?steps\b/i;
/** Sections the think prompt asks for after the steps; any of them ends the list. */
const NEXT_SECTION =
  /^\s*(?:#+\s*)?(?:\*\*)?\s*(?:\d+[.)]\s*)?(?:\*\*)?\s*(?:how (?:you|i) will verify|verif(?:y|ication)|spec cases|risks?)\b/i;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)]|step\s+\d+[:.)]?)\s+(.*)$/i;

function clean(text: string): string {
  const t = text
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= ITEM_CHARS ? t : `${t.slice(0, ITEM_CHARS - 1)}…`;
}

/**
 * The ordered steps of a think-phase analysis, as todo texts: the items under its "Ordered
 * steps" section, outermost level only. Empty when there is no such section or it lists fewer
 * than two steps, since one step isn't worth a checklist.
 */
export function analysisSteps(analysis: string): string[] {
  const lines = analysis.split('\n');
  const start = lines.findIndex((l) => STEPS_HEADING.test(l));
  if (start < 0) return [];
  const steps: string[] = [];
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (NEXT_SECTION.test(line) || /^\s*#+\s/.test(line)) break;
    const m = ITEM.exec(line);
    if (!m) continue;
    const depth = (m[1] ?? '').replace(/\t/g, '  ').length;
    indent ??= depth;
    if (depth > indent) continue;
    const text = clean(m[2] ?? '');
    if (text) steps.push(text);
    if (steps.length >= MAX_STEPS) break;
  }
  return steps.length >= 2 ? steps : [];
}

/** A checklist for the steps, the first one under way. */
export function stepsTodo(steps: readonly string[], allDone = false): TodoItem[] {
  return steps.map((text, i) => ({
    text,
    status: allDone ? 'done' : i === 0 ? 'in_progress' : 'pending',
  }));
}

/** Whether the model has kept its own todo list in this conversation. */
export function wroteTodo(messages: readonly Message[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use' && b.name === 'todo'),
  );
}
