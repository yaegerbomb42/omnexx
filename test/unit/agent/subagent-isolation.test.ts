import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DENIED,
  formatSubagentResult,
  helperRunner,
  RESULT_MAX_CHARS,
  safeSubagentTools,
  type HelperEnv,
  type SubagentResult,
} from '../../../src/agent/subagent.js';
import { taskTool } from '../../../src/tools/task.js';
import { ok, type Tool, type ToolContext } from '../../../src/tools/types.js';
import type { EventLog } from '../../../src/core/events.js';
import type { PathJail } from '../../../src/security/paths.js';
import type { ResolvedModel } from '../../../src/providers/pricing.js';
import { z } from 'zod';

function dummyTool(name: string, readOnly = true): Tool {
  return {
    name,
    description: `Dummy tool ${name}`,
    schema: z.object({}),
    readOnly,
    run() {
      return Promise.resolve(ok(`${name} output`));
    },
  };
}

const mockModel: ResolvedModel = {
  provider: 'mock',
  alias: 'mock',
  id: 'mock-id',
  price: {
    id: 'mock-id',
    input: 0,
    output: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  },
};

const mockBudget = {
  max_usd: 10,
  max_usd_per_day: 10,
  max_hours: 1,
  max_cycles: 10,
  max_turns_per_cycle: 5,
  max_tokens_per_cycle: 10000,
  max_cmd_timeout: '2m',
  max_provider_wait: '30s',
  warn_at: 0.8,
  wrapup_reserve: 0.1,
};

describe('Subagent Isolation & Research Sandbox', () => {
  describe('Tool Sandboxing & Denial', () => {
    it('strictly denies mutating and execution tools from subagent scope', () => {
      expect(DENIED.has('bash')).toBe(true);
      expect(DENIED.has('write_file')).toBe(true);
      expect(DENIED.has('str_replace')).toBe(true);
      expect(DENIED.has('apply_patch')).toBe(true);
      expect(DENIED.has('task')).toBe(true);
      expect(DENIED.has('todo')).toBe(true);
    });

    it('filters out denied tools even when requested by an agent card', () => {
      const allTools: Tool[] = [
        dummyTool('read', true),
        dummyTool('search', true),
        dummyTool('bash', false),
        dummyTool('write_file', false),
        dummyTool('task', true),
      ];

      const card = {
        name: 'researcher',
        description: 'Research agent',
        prompt: 'Research things',
        tools: ['read', 'bash', 'write_file', 'task'],
      };

      const resolved = safeSubagentTools(allTools, card);
      const names = resolved.map((t) => t.name);

      expect(names).toContain('read');
      expect(names).not.toContain('bash');
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('task');
    });

    it('defaults to safe read-only tools when card has no specific tool overrides', () => {
      const allTools: Tool[] = [
        dummyTool('read', true),
        dummyTool('outline', true),
        dummyTool('bash', false),
        dummyTool('task', true),
      ];

      const resolved = safeSubagentTools(allTools, undefined);
      const names = resolved.map((t) => t.name);

      expect(names).toEqual(['read', 'outline']);
    });
  });

  describe('Result Bounding & File Extraction', () => {
    it('truncates excessive findings to RESULT_MAX_CHARS', async () => {
      const longText = 'A'.repeat(RESULT_MAX_CHARS + 500);
      const events = new EventEmitter();
      const emitted: { event: string; data: unknown }[] = [];
      events.on('subagent.start', (d) => emitted.push({ event: 'subagent.start', data: d }));
      events.on('subagent.finish', (d) => emitted.push({ event: 'subagent.finish', data: d }));
      events.on('subagent.artifact', (d) => emitted.push({ event: 'subagent.artifact', data: d }));

      const env: HelperEnv = {
        tools: () => Promise.resolve([dummyTool('read')]),
        models: () => Promise.resolve([mockModel]),
        maxTokens: 1000,
        limits: { tokens: 10000, turns: 5 },
        loop: {
          provider: {
            name: 'mock',
            complete() {
              return Promise.resolve({
                content: [{ type: 'text', text: `${longText}\nConfidence: 95%` }],
                stopReason: 'end_turn',
                usage: { uncached: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 20 },
                model: 'mock',
              });
            },
          },
          providerBlocked: () => undefined,
          modelExhausted: () => false,
          markExhausted: () => undefined,
          markRateLimited: () => undefined,
          coolProvider: () => undefined,
          budget: mockBudget,
          clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
          events: events as unknown as EventLog,
          taskId: () => 'M1.T01',
          cycle: () => 1,
          spentUsd: () => 0,
          spentTodayUsd: () => 0,
          onUsage: () => Promise.resolve(),
          control: () => Promise.resolve('continue'),
          signal: new AbortController().signal,
        },
      };

      const parentCtx = {
        jail: { root: '/repo' } as unknown as PathJail,
        env: {},
        edited: new Set(['parent.ts']),
        reads: new Map([['parent.ts', 'hash']]),
        nextCommandId: () => 'cmd-1',
        subagent: () => Promise.resolve({ findings: '', files: [], confidence: 1 }),
      } as unknown as ToolContext;

      const run = helperRunner(env, parentCtx);
      const result = await run('Investigate something', 'explore');

      expect(result.findings.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
      expect(result.findings.endsWith('…')).toBe(true);
      expect(result.confidence).toBe(0.95);

      // Verify artifact was emitted out-of-band with full messages
      const artifact = emitted.find((e) => e.event === 'subagent.artifact');
      expect(artifact).toBeDefined();
    });

    it('extracts, deduplicates, and caps file references to at most 8', async () => {
      const responseWithFiles = [
        'Here is the analysis:',
        'See src/auth/login.ts:42 and src/auth/login.ts:42 again.',
        'Also check src/utils/jwt.ts:15, src/server.ts, and tests/auth.test.ts:99.',
        'More files: src/a.ts:1, src/b.ts:2, src/c.ts:3, src/d.ts:4, src/e.ts:5, src/f.ts:6.',
        'Confidence: 85%',
      ].join('\n');

      const events = new EventEmitter();
      const env: HelperEnv = {
        tools: () => Promise.resolve([dummyTool('read')]),
        models: () => Promise.resolve([mockModel]),
        maxTokens: 1000,
        limits: { tokens: 10000, turns: 5 },
        loop: {
          provider: {
            name: 'mock',
            complete() {
              return Promise.resolve({
                content: [{ type: 'text', text: responseWithFiles }],
                stopReason: 'end_turn',
                usage: { uncached: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 20 },
                model: 'mock',
              });
            },
          },
          providerBlocked: () => undefined,
          modelExhausted: () => false,
          markExhausted: () => undefined,
          markRateLimited: () => undefined,
          coolProvider: () => undefined,
          budget: mockBudget,
          clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
          events: events as unknown as EventLog,
          taskId: () => 'M1.T01',
          cycle: () => 1,
          spentUsd: () => 0,
          spentTodayUsd: () => 0,
          onUsage: () => Promise.resolve(),
          control: () => Promise.resolve('continue'),
          signal: new AbortController().signal,
        },
      };

      const parentCtx = {
        jail: { root: '/repo' } as unknown as PathJail,
        env: {},
        edited: new Set(),
        reads: new Map(),
        nextCommandId: () => 'cmd-1',
      } as unknown as ToolContext;

      const run = helperRunner(env, parentCtx);
      const result = await run('Check login flow', 'research');

      expect(result.files.length).toBeLessThanOrEqual(8);
      // login.ts:42 should only appear once
      const loginCount = result.files.filter((f) => f === 'src/auth/login.ts:42').length;
      expect(loginCount).toBe(1);
      expect(result.confidence).toBe(0.85);
    });
  });

  describe('formatSubagentResult', () => {
    it('formats findings, key files, and confidence cleanly', () => {
      const res: SubagentResult = {
        findings: 'Auth token validation is missing expiration check.',
        files: ['src/auth/token.ts:50', 'src/middleware/auth.ts:22'],
        confidence: 0.9,
      };

      const formatted = formatSubagentResult(res);
      expect(formatted).toContain('Auth token validation is missing expiration check.');
      expect(formatted).toContain('Key Files:\n- src/auth/token.ts:50\n- src/middleware/auth.ts:22');
      expect(formatted).toContain('Confidence: 90%');
    });

    it('handles results with no referenced files', () => {
      const res: SubagentResult = {
        findings: 'The documentation confirms HMAC-SHA256 is supported.',
        files: [],
        confidence: 0.95,
      };

      const formatted = formatSubagentResult(res);
      expect(formatted).not.toContain('Key Files:');
      expect(formatted).toContain('Confidence: 95%');
    });
  });

  describe('taskTool', () => {
    it('fails when context does not have subagent capability', async () => {
      const ctx = {
        jail: { root: '/repo' } as unknown as PathJail,
        env: {},
        edited: new Set(),
        reads: new Map(),
        nextCommandId: () => 'cmd-1',
      } as unknown as ToolContext;

      const res = await taskTool.run({ description: 'Explore authentication modules' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content).toContain('task is not available here');
    });

    it('delegates to subagent and returns formatted synthesized output', async () => {
      const ctx = {
        jail: { root: '/repo' } as unknown as PathJail,
        env: {},
        edited: new Set(),
        reads: new Map(),
        nextCommandId: () => 'cmd-1',
        subagent: (desc: string, kind: string) =>
          Promise.resolve({
            findings: `Analyzed ${desc} under ${kind} mode: all systems nominal.`,
            files: ['src/index.ts:1'],
            confidence: 0.99,
          }),
      } as unknown as ToolContext;

      const res = await taskTool.run(
        { description: 'Explore system integrity', kind: 'explore' },
        ctx,
      );
      expect(res.isError).toBeUndefined();
      expect(res.content).toContain('Analyzed Explore system integrity under explore mode');
      expect(res.content).toContain('Key Files:\n- src/index.ts:1');
      expect(res.content).toContain('Confidence: 99%');
    });
  });
});
