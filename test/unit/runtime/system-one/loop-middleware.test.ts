import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoop, type LoopDeps } from '../../../../src/agent/loop.js';
import { budgetSchema } from '../../../../src/config/schema.js';
import type { OmnexxEvent } from '../../../../src/core/events.js';
import { SystemOneClient } from '../../../../src/runtime/system-one/client.js';
import { SystemOneMiddleware } from '../../../../src/runtime/system-one/middleware.js';
import { snapshotFromEvents } from '../../../../src/runtime/system-one/observe.js';
import { fail, type Tool, type ToolContext } from '../../../../src/tools/types.js';
import { FakeClock } from '../../../support/clock.js';
import { makeRepo } from '../../../support/harness.js';
import { ScriptedProvider, type ScriptedTurn } from '../../../support/scripted-provider.js';
import { toolContext } from '../../../support/tool-context.js';

const AUTH = `export function checkAuthToken(token: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  return verifySignature(parts);
}
`;

function tools(ran: string[]): Tool[] {
  const bashSchema = z.strictObject({ command: z.string() });
  const bash: Tool<typeof bashSchema> = {
    name: 'bash',
    description: 'run a command',
    schema: bashSchema,
    readOnly: false,
    run(input) {
      ran.push(input.command);
      if (input.command.includes('vitest')) {
        const lines = Array.from(
          { length: 300 },
          (_, i) => `  ✓ test/case-${String(i)}.test.ts (2 tests) 4ms`,
        );
        return Promise.resolve({ content: [...lines, ' Test Files  300 passed (300)'].join('\n') });
      }
      return Promise.resolve({ content: ` src/auth.ts | 2 +-` });
    },
  };
  const editSchema = z.strictObject({ path: z.string(), old_str: z.string(), new_str: z.string() });
  const strReplace: Tool<typeof editSchema> = {
    name: 'str_replace',
    description: 'edit',
    schema: editSchema,
    readOnly: false,
    async run(input, ctx: ToolContext) {
      const p = ctx.jail.resolve(input.path, 'write');
      const text = await readFile(p, 'utf8');
      if (!text.includes(input.old_str)) return fail('no match');
      await writeFile(p, text.replace(input.old_str, input.new_str));
      return { content: `edited ${input.path}` };
    },
  };
  const readSchema = z.strictObject({ path: z.string() });
  const read: Tool<typeof readSchema> = {
    name: 'read',
    description: 'read',
    schema: readSchema,
    readOnly: true,
    concurrent: true,
    run: (input, ctx) =>
      readFile(ctx.jail.resolve(input.path, 'read'), 'utf8').then((content) => ({ content })),
  };
  return [bash, strReplace, read] as Tool[];
}

const SUMMARY =
  'Tightened checkAuthToken in src/auth.ts so empty and malformed tokens are rejected before signature checks; the suite passes.';

const script: ScriptedTurn[] = [
  // A lazy edit: 4 lines of logic replaced by a placeholder. Rejected before disk.
  {
    tools: [
      {
        name: 'str_replace',
        input: {
          path: 'src/auth.ts',
          old_str:
            "  if (!token) return false;\n  const parts = token.split('.');\n  if (parts.length !== 3) return false;\n  return verifySignature(parts);",
          new_str: '  // ... existing code ...\n  return verifySignature(parts);',
        },
      },
    ],
  },
  // A destructive command with no one to approve it: blocked.
  { tools: [{ name: 'bash', input: { command: 'rm -rf ./*' } }] },
  {
    tools: [
      {
        name: 'str_replace',
        input: {
          path: 'src/auth.ts',
          old_str: '  if (!token) return false;',
          new_str: "  if (!token || token.trim() === '') return false;",
        },
      },
    ],
  },
  { tools: [{ name: 'bash', input: { command: 'npx vitest run' } }] },
  { text: SUMMARY, tools: [{ name: 'read', input: { path: 'src/auth.ts' } }] },
  { text: SUMMARY, tools: [{ name: 'bash', input: { command: 'git diff --stat' } }] },
  { text: 'should never be reached' },
];

describe('System-1 middleware inside runAgentLoop', () => {
  it('runs intent → frontier → guardrail/patch-sanity → tool + triage → early stop, prefix intact', async () => {
    const repo = await makeRepo({ 'src/auth.ts': AUTH });
    const toolCtx = await toolContext(repo);
    const events: OmnexxEvent[] = [];
    toolCtx.events.onEvent((e) => events.push(e));
    const ran: string[] = [];
    const provider = new ScriptedProvider(({ turn }) => script[turn] ?? { text: 'done' });
    const systemOne = new SystemOneMiddleware(
      new SystemOneClient({ backend: 'local' }),
      {
        destructiveThreshold: 0.85,
        earlyStopThreshold: 0.9,
        speculativeThreshold: 0.8,
        patchPlaceholderThreshold: 0.85,
        gates: {
          guardrail: true,
          earlyStop: true,
          outputTriage: true,
          speculativeRouting: true,
          patchSanity: true,
        },
      },
      toolCtx.events,
      repo,
    );
    const deps: LoopDeps = {
      provider,
      models: [
        {
          provider: 'scripted',
          alias: 'm',
          id: 'm',
          price: {
            id: 'm',
            input: 0,
            output: 0,
            cache_write_5m: 0,
            cache_write_1h: 0,
            cache_read: 0,
          },
        },
      ],
      tools: tools(ran),
      toolCtx,
      budget: budgetSchema.parse({}),
      maxTokens: 1_000,
      clock: new FakeClock(),
      events: toolCtx.events,
      spentUsd: () => 0,
      onUsage: () => Promise.resolve(),
      control: () => Promise.resolve('continue'),
      systemOne,
    };
    const res = await runAgentLoop(
      {
        system: [{ text: 'You are a coding agent.' }],
        first: {
          role: 'user',
          content: [{ type: 'text', text: 'show me where auth tokens are checked and harden it' }],
        },
        tools: [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }],
      },
      deps,
    );

    // Gate 4: the first request already carries the pre-fetched search, in the user turn.
    const first = provider.requests[0];
    const firstUser =
      first?.messages[0]?.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n') ?? '';
    expect(firstUser).toContain('[system1:speculative explain_code');
    expect(firstUser).toContain('src/auth.ts');
    // The cached prefix never changes across turns.
    const prefixes = new Set(provider.requests.map((r) => JSON.stringify([r.system, r.tools])));
    expect(prefixes.size).toBe(1);

    // Gate 5: the lazy edit never reached disk; the real one did.
    const results = res.messages.flatMap((m) =>
      m.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])),
    );
    expect(results[0]).toContain('[system1:patch-sanity] Rejected before writing src/auth.ts');
    const final = await readFile(join(repo, 'src/auth.ts'), 'utf8');
    expect(final).toContain("token.trim() === ''");
    expect(final).toContain('verifySignature(parts)');

    // Gate 1: blocked without running.
    expect(results[1]).toContain('[system1:guardrail] Command blocked');
    expect(ran).not.toContain('rm -rf ./*');

    // Gate 3: 300 passing lines pruned, the summary line kept.
    expect(results[3]).toContain('[system1:triage pruned');
    expect(results[3]).toContain('Test Files  300 passed (300)');
    expect(results[3]?.split('\n').length).toBeLessThan(20);

    // Gate 2: stopped after the redundant read + git diff, before the 7th request.
    expect(res.end).toBe('done');
    expect(provider.requests).toHaveLength(6);
    expect(res.finalText).toBe(
      `${SUMMARY}\n\nDone. Changed src/auth.ts; the checks passed after the last edit.`,
    );
    expect(res.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: res.finalText }],
    });

    const snap = snapshotFromEvents(events);
    expect(snap?.intent?.label).toBe('explain_code');
    expect(snap?.speculative.hits).toBe(1);
    expect(snap?.guardrail).toEqual({ checked: 3, intercepted: 1 });
    expect(snap?.patch).toEqual({ checked: 2, caught: 1 });
    expect(snap?.earlyStop.turnsSaved).toBe(1);
    expect(snap?.tokensSaved).toBeGreaterThan(8_000);
  });

  it('asks the person in interactive chat and runs the command when they approve', async () => {
    const repo = await makeRepo();
    const asked: string[] = [];
    const toolCtx = await toolContext(repo, {
      ask: (q) => {
        asked.push(q);
        return Promise.resolve(true);
      },
    });
    const mw = new SystemOneMiddleware(
      new SystemOneClient({ backend: 'local' }),
      {
        destructiveThreshold: 0.85,
        earlyStopThreshold: 0.9,
        speculativeThreshold: 0.8,
        patchPlaceholderThreshold: 0.85,
        gates: {
          guardrail: true,
          earlyStop: true,
          outputTriage: true,
          speculativeRouting: true,
          patchSanity: true,
        },
      },
      toolCtx.events,
      repo,
    );
    expect(
      await mw.beforeTool('bash', { command: 'sqlite3 app.db "DROP TABLE users"' }, toolCtx),
    ).toBeUndefined();
    expect(asked[0]).toMatch(/System-1 flags it as destructive \(prob 0\.\d\d\)/);
    const denying = await toolContext(repo, { ask: () => Promise.resolve(false) });
    expect(
      await mw.beforeTool('bash', { command: 'sqlite3 app.db "DROP TABLE users"' }, denying),
    ).toMatch(
      /^\[system1:guardrail\] Command blocked by user confirmation \(destructive prob=0\.\d\d\)/,
    );
    expect(await mw.beforeTool('bash', { command: 'npm test' }, denying)).toBeUndefined();
  });
});
