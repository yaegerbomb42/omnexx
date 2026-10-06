import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AiderAdapter,
  ClaudeCodeAdapter,
  ClineAdapter,
  CodexAdapter,
  createWorkerAdapter,
  GeminiCliAdapter,
  OpenCodeAdapter,
  QwenCodeAdapter,
} from '../../../src/workers/adapters/index.js';
import type { InvocationContext, WorkerTask } from '../../../src/workers/types.js';
import { tempDir } from '../../support/tmp.js';

describe('worker adapters contract tests', () => {
  const task: WorkerTask = {
    id: 'T1',
    title: 'Fix issue',
    acceptance: ['checks pass'],
    checks: ['npm test'],
    evidence: [],
  };

  const getCtx = async (tmp: string): Promise<InvocationContext> => {
    const promptFile = resolve(tmp, 'prompt.md');
    await writeFile(promptFile, 'Fix issue\n');
    return {
      worktree: tmp,
      promptFile,
      prompt: 'Fix issue',
    };
  };

  describe('createWorkerAdapter factory', () => {
    it('creates all known adapter instances', () => {
      expect(createWorkerAdapter('claude-code')).toBeInstanceOf(ClaudeCodeAdapter);
      expect(createWorkerAdapter('codex')).toBeInstanceOf(CodexAdapter);
      expect(createWorkerAdapter('opencode')).toBeInstanceOf(OpenCodeAdapter);
      expect(createWorkerAdapter('aider')).toBeInstanceOf(AiderAdapter);
      expect(createWorkerAdapter('gemini-cli')).toBeInstanceOf(GeminiCliAdapter);
      expect(createWorkerAdapter('qwen-code')).toBeInstanceOf(QwenCodeAdapter);
      expect(createWorkerAdapter('cline')).toBeInstanceOf(ClineAdapter);
      expect(createWorkerAdapter('unknown')).toBeUndefined();
    });
  });

  describe('argv building: arrays, never shell strings; never credentials in env', () => {
    it('claude-code builds argv array', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new ClaudeCodeAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('claude');
      expect(inv.argv).toContain('-p');
      expect(inv.argv).toContain('Fix issue');
      expect(inv.argv).toContain('--output-format');
      expect(inv.argv).toContain('stream-json');
      expect(inv.argv).toContain('--no-session-persistence');
      // No supervisor secrets
      expect(Object.keys(inv.env)).not.toContain('ANTHROPIC_API_KEY');
    });

    it('codex builds argv array', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new CodexAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('codex');
      expect(inv.argv).toContain('exec');
      expect(inv.argv).toContain('-C');
      expect(inv.argv).toContain(ctx.worktree);
      expect(inv.argv).toContain('--json');
      expect(inv.argv).toContain('--ephemeral');
      expect(inv.argv).toContain(ctx.prompt);
    });

    it('opencode builds argv array', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new OpenCodeAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('opencode');
      expect(inv.argv).toContain('run');
      expect(inv.argv).toContain('--dir');
      expect(inv.argv).toContain(ctx.worktree);
      expect(inv.argv).toContain('--auto');
      expect(inv.argv).toContain('--format');
      expect(inv.argv).toContain('json');
    });

    it('aider builds argv array with message file', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new AiderAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('aider');
      expect(inv.argv).toContain('--message-file');
      expect(inv.argv).toContain(ctx.promptFile);
      expect(inv.argv).toContain('--yes-always');
      expect(inv.argv).toContain('--no-auto-commits');
    });

    it('gemini-cli builds argv array', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new GeminiCliAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('gemini');
      expect(inv.argv).toContain('-p');
      expect(inv.argv).toContain(ctx.prompt);
    });

    it('qwen-code builds argv array', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new QwenCodeAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('qwen');
      expect(inv.argv).toContain('-p');
      expect(inv.argv).toContain(ctx.prompt);
    });

    it('cline builds argv array with json and auto-approve', async () => {
      const tmp = await tempDir();
      const ctx = await getCtx(tmp);
      const adapter = new ClineAdapter();
      const inv = adapter.buildInvocation(task, ctx);

      expect(Array.isArray(inv.argv)).toBe(true);
      expect(inv.argv[0]).toBe('cline');
      expect(inv.argv).toContain('--json');
      expect(inv.argv).toContain('--auto-approve');
      expect(inv.argv).toContain('true');
      expect(inv.argv).toContain('--cwd');
      expect(inv.argv).toContain(ctx.worktree);
    });
  });

  describe('contract tests against recorded mock scripts: detection and result parsing', () => {
    it('claude-code parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/claude-code/mock-claude.mjs');
      const adapter = new ClaudeCodeAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);
      expect(d.version).toContain('2.1.288');

      // Completed
      const stdoutFile = resolve(tmp, 'claude.stdout');
      const stderrFile = resolve(tmp, 'claude.stderr');
      await writeFile(
        stdoutFile,
        JSON.stringify({ type: 'result', result: 'All tests green', total_cost_usd: 0.04 }) + '\n',
      );
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');
      expect(res.summary).toBe('All tests green');
      expect(res.usage?.usd).toBe(0.04);

      // Quota exhausted
      await writeFile(stderrFile, 'credit balance is too low\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');

      // Rate limited
      await writeFile(stderrFile, 'Rate limit exceeded\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('rate_limited');

      // Auth required
      await writeFile(stderrFile, 'authentication_error: Invalid API Key\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('auth_required');

      // Timeout
      expect((await adapter.parseResult(143, stdoutFile, stderrFile)).status).toBe('timeout');
    });

    it('codex parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/codex/mock-codex.mjs');
      const adapter = new CodexAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);
      expect(d.version).toContain('0.132.0');

      const stdoutFile = resolve(tmp, 'codex.stdout');
      const stderrFile = resolve(tmp, 'codex.stderr');
      await writeFile(
        stdoutFile,
        JSON.stringify({ type: 'item', msg: 'Fixed task', tokens: { in: 100, out: 40 } }) + '\n',
      );
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');
      expect(res.summary).toBe('Fixed task');
      expect(res.usage?.inputTokens).toBe(100);

      // Quota
      await writeFile(stderrFile, 'insufficient_quota\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');

      // Rate limit
      await writeFile(stderrFile, 'rate_limit_exceeded\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('rate_limited');

      // Auth
      await writeFile(stderrFile, 'Missing API key\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('auth_required');
    });

    it('opencode parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/opencode/mock-opencode.mjs');
      const adapter = new OpenCodeAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);

      const stdoutFile = resolve(tmp, 'opencode.stdout');
      const stderrFile = resolve(tmp, 'opencode.stderr');
      await writeFile(
        stdoutFile,
        JSON.stringify({ summary: 'Finished patch', tokens: { input: 80, output: 20 } }) + '\n',
      );
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');
      expect(res.summary).toBe('Finished patch');

      await writeFile(stderrFile, 'quota_exhausted\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');
    });

    it('aider parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/aider/mock-aider.mjs');
      const adapter = new AiderAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);

      const stdoutFile = resolve(tmp, 'aider.stdout');
      const stderrFile = resolve(tmp, 'aider.stderr');
      await writeFile(stdoutFile, 'Applied edit to src/app.ts\nTokens: 300 Cost: $0.015\n');
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');
      expect(res.summary).toContain('Applied edit to src/app.ts');
      expect(res.usage?.usd).toBe(0.015);

      await writeFile(stderrFile, 'insufficient_quota\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');
    });

    it('gemini-cli parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/gemini-cli/mock-gemini.mjs');
      const adapter = new GeminiCliAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);

      const stdoutFile = resolve(tmp, 'gemini.stdout');
      const stderrFile = resolve(tmp, 'gemini.stderr');
      await writeFile(stdoutFile, 'Done generating content\n');
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');

      await writeFile(stderrFile, 'ResourceExhausted\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('rate_limited');
    });

    it('qwen-code parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/qwen-code/mock-qwen.mjs');
      const adapter = new QwenCodeAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);

      const stdoutFile = resolve(tmp, 'qwen.stdout');
      const stderrFile = resolve(tmp, 'qwen.stderr');
      await writeFile(stdoutFile, 'Done with changes\n');
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');

      await writeFile(stderrFile, 'QuotaExceeded\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');
    });

    it('cline parses outcomes: completed, quota, rate-limit, auth', async () => {
      const tmp = await tempDir();
      const script = resolve('test/fixtures/workers/cline/mock-cline.mjs');
      const adapter = new ClineAdapter({ path: script });

      const d = await adapter.detect();
      expect(d.installed).toBe(true);

      const stdoutFile = resolve(tmp, 'cline.stdout');
      const stderrFile = resolve(tmp, 'cline.stderr');
      await writeFile(
        stdoutFile,
        JSON.stringify({ type: 'say', say: 'text', message: 'Cline finished' }) + '\n',
      );
      await writeFile(stderrFile, '');
      const res = await adapter.parseResult(0, stdoutFile, stderrFile);
      expect(res.status).toBe('completed');
      expect(res.summary).toBe('Cline finished');

      await writeFile(stderrFile, 'quota_exhausted\n');
      expect((await adapter.parseResult(1, stdoutFile, stderrFile)).status).toBe('quota_exhausted');
    });
  });
});
