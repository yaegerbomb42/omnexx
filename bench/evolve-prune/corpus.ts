import type { Message } from '../../src/providers/types.js';
let n = 0;
const pad = (label: string, k = 1800) => `${label}\n${'// code line\n'.repeat(Math.ceil(k / 13))}`;
const step = (name: string, input: unknown, content: string, isError = false): Message[] => {
  const id = `c${++n}`;
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: id, content, isError }] },
  ];
};
const user = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] });
export interface Case { name: string; split: 'train' | 'holdout'; messages: Message[]; mustKeep: string[] }
export const corpus: Case[] = [
  { name: 'reread-fix', split: 'train', mustKeep: ['GOAL: fix parser', 'A_V2_MARK', 'TS2345 at src/p.ts:42'], messages: [
    user('GOAL: fix parser'), ...step('read', { path: 'src/a.ts' }, pad('A_V1')),
    ...step('bash', { command: 'npm run typecheck' }, pad('TS2345 at src/p.ts:42'), true),
    ...step('read', { path: 'src/a.ts' }, pad('A_V2_MARK')) ] },
  { name: 'test-flip', split: 'train', mustKeep: ['GOAL: tests green', 'PASS 40 tests'], messages: [
    user('GOAL: tests green'), ...step('bash', { command: 'npm test' }, pad('FAIL 3 of 40'), true),
    ...step('edit', { path: 'src/x.ts' }, 'ok'), ...step('bash', { command: 'npm test' }, pad('PASS 40 tests')) ] },
  { name: 'edit-then-read', split: 'train', mustKeep: ['GOAL: rename', 'B_AFTER_EDIT', 'UNRESOLVED lint in src/c.ts'], messages: [
    user('GOAL: rename'), ...step('read', { path: 'src/b.ts', start: 1, end: 80 }, pad('B_BEFORE')),
    ...step('edit', { path: 'src/b.ts' }, 'applied'), ...step('read', { path: 'src/b.ts' }, pad('B_AFTER_EDIT')),
    ...step('bash', { command: 'npm run lint' }, pad('UNRESOLVED lint in src/c.ts'), true) ] },
  { name: 'grep-repeat', split: 'train', mustKeep: ['GOAL: find usages', 'HITS_V2 src/q.ts'], messages: [
    user('GOAL: find usages'), ...step('grep', { pattern: 'foo', path: 'src' }, pad('HITS_V1 src/z.ts')),
    ...step('edit', { path: 'src/z.ts' }, 'ok'), ...step('grep', { pattern: 'foo', path: 'src' }, pad('HITS_V2 src/q.ts')) ] },
  { name: 'narrow-reads', split: 'train', mustKeep: ['GOAL: x', 'WIDE_FILE', 'NARROW_10_20'], messages: [
    user('GOAL: x'), ...step('read', { path: 'src/w.ts' }, pad('WIDE_FILE')),
    ...step('read', { path: 'src/w.ts', start: 10, end: 20 }, pad('NARROW_10_20')) ] },
  { name: 'cmd-ws', split: 'train', mustKeep: ['GOAL: build', 'BUILD OK'], messages: [
    user('GOAL: build'), ...step('bash', { command: 'npm run build' }, pad('BUILD FAIL'), true),
    ...step('bash', { command: 'npm run build ' }, pad('BUILD OK')) ] },
  { name: 'trap-edit-noreread', split: 'train', mustKeep: ['GOAL: patch', 'ONLY_COPY_OF_D', 'E_AFTER'], messages: [
    user('GOAL: patch'), ...step('read', { path: 'src/d.ts' }, pad('ONLY_COPY_OF_D')), ...step('edit', { path: 'src/d.ts' }, 'ok'),
    ...step('read', { path: 'src/e.ts' }, pad('E_BEFORE')), ...step('edit', { path: 'src/e.ts' }, 'ok'), ...step('read', { path: 'src/e.ts', start: 1, end: 5 }, pad('E_AFTER')) ] },
  { name: 'trap-distinct-cmds', split: 'train', mustKeep: ['GOAL: ci', 'UNIT FAIL', 'E2E PASS', 'GREP_A', 'GREP_B'], messages: [
    user('GOAL: ci'), ...step('bash', { command: 'npm run test:unit' }, pad('UNIT FAIL'), true), ...step('bash', { command: 'npm run test:e2e' }, pad('E2E PASS')),
    ...step('grep', { pattern: 'a' }, pad('GREP_A')), ...step('grep', { pattern: 'b' }, pad('GREP_B')) ] },
  // holdout
  { name: 'ho-multi-read', split: 'holdout', mustKeep: ['GOAL: refactor', 'R3_MARK', 'S_ONLY'], messages: [
    user('GOAL: refactor'), ...step('read', { path: 'src/r.ts' }, pad('R1')), ...step('read', { path: 'src/s.ts' }, pad('S_ONLY')),
    ...step('read', { path: 'src/r.ts', start: 1, end: 999 }, pad('R2')), ...step('read', { path: 'src/r.ts' }, pad('R3_MARK')) ] },
  { name: 'ho-test-regress', split: 'holdout', mustKeep: ['GOAL: ship', 'FAIL regression in auth'], messages: [
    user('GOAL: ship'), ...step('bash', { command: 'npm test' }, pad('PASS all')),
    ...step('edit', { path: 'src/auth.ts' }, 'ok'), ...step('bash', { command: 'npm test' }, pad('FAIL regression in auth'), true) ] },
  { name: 'ho-grep-glob', split: 'holdout', mustKeep: ['GOAL: audit', 'G2_MARK', 'GLOB_LIST'], messages: [
    user('GOAL: audit'), ...step('grep', { pattern: 'TODO' }, pad('G1')), ...step('glob', { pattern: '**/*.ts' }, pad('GLOB_LIST')),
    ...step('grep', { pattern: 'TODO' }, pad('G2_MARK')) ] },
  { name: 'ho-ws-glob', split: 'holdout', mustKeep: ['GOAL: lint', 'LINT CLEAN', 'GLOB_NEW', 'F_KEEP'], messages: [
    user('GOAL: lint'), ...step('bash', { command: 'npx  eslint src' }, pad('LINT ERRORS'), true), ...step('glob', { pattern: 'src/**' }, pad('GLOB_OLD')),
    ...step('read', { path: 'src/f.ts' }, pad('F_KEEP')), ...step('edit', { path: 'src/f.ts' }, 'ok'),
    ...step('glob', { pattern: 'src/**' }, pad('GLOB_NEW')), ...step('bash', { command: 'npx eslint src' }, pad('LINT CLEAN')) ] },
];
