import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCodemap, renderCodemap } from '../agent/codemap.js';
import { runAgentLoop } from '../agent/loop.js';
import type { CliIO } from '../cli/io.js';
import { resolveRunDeps } from '../cli/run-deps.js';
import type { OmnexxConfig } from '../config/schema.js';
import { parseDuration } from '../config/duration.js';
import { EventLog } from '../core/events.js';
import { RunStore } from '../core/run-store.js';
import { realClock } from '../core/clock.js';
import { loadInstructions, renderInstructions } from '../instructions/load.js';
import { resolveChain } from '../providers/pricing.js';
import type { Message, Provider } from '../providers/types.js';
import { scrubEnv } from '../security/env-scrub.js';
import { PathJail } from '../security/paths.js';
import { Redactor } from '../security/redact.js';
import { humanize } from '../telemetry/humanize.js';
import { brand } from '../cli/brand.js';
import { workerTools, toolSpec } from '../tools/registry.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { runGates } from '../verify/gates.js';

export const CHAT_SYSTEM = `You are Omnexx in chat mode: a coding agent working turn by turn with a person at the keyboard, directly in their repository (your cwd).

- Do what they ask in this message, then stop and reply briefly: what you changed and what you checked.
- Explore with the codebase map, outline, search and ranged reads. Edit with str_replace / multi_edit; write_file for new or small files.
- Run the relevant tests with bash before you finish when you changed code.
- Some actions need their OK (paths outside the repo, commands the policy refuses); they are asked for you. If they say no, find another way or explain.
- Ask a question instead of guessing when the request is ambiguous and the choice matters.`;

/** Tools chat leaves out: helpers need a run, and the planner's tools don't apply. */
const CHAT_DENIED = new Set(['task']);

/**
 * Turn-by-turn coding in the user's own checkout (no worktree, no rollback): the conversation
 * carries across messages, edits land immediately, and after each message that edited files the
 * configured gates run and report (they inform; they don't revert).
 */
export class CodeChat {
  private history: Message[] = [];
  usd = 0;

  private constructor(
    private readonly config: OmnexxConfig,
    private readonly provider: Provider,
    private readonly tools: readonly Tool[],
    private readonly system: { text: string; cacheBreakpoint?: boolean }[],
    private readonly ctx: ToolContext,
    private readonly events: EventLog,
    private readonly store: RunStore,
  ) {}

  static async open(io: CliIO, ask: (q: string) => Promise<boolean>): Promise<CodeChat> {
    const { config, paths, deps } = await resolveRunDeps(io, io.cwd);
    const store = new RunStore(
      paths,
      `chat_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
    );
    await mkdir(store.logsDir, { recursive: true, mode: 0o700 });
    const redactor = Redactor.fromEnv(io.env, deps.secrets);
    const clock = io.clock ?? realClock;
    const events = new EventLog(store.eventsPath, store.runId, redactor, clock);
    const tmp = join('/tmp', `omnexx-${store.runId}`);
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const jail = new PathJail(io.cwd);
    let n = 0;
    const ctx: ToolContext = {
      jail,
      env: scrubEnv(io.env, { passthrough: config.policy.env_passthrough, set: { TMPDIR: tmp } }),
      store,
      events,
      redactor,
      policy: {
        root: jail.root,
        home: io.env.HOME ?? '/nonexistent',
        allowNetwork: config.policy.allow_network,
        extraDeny: config.policy.deny,
        scratch: [tmp, `/private${tmp}`],
      },
      cycle: 0,
      maxCmdTimeoutMs: parseDuration(config.budget.max_cmd_timeout),
      notesMaxTokens: config.context.notes_max_tokens,
      today: new Date(clock.now()).toISOString().slice(0, 10),
      nextCommandId: () => `cmd-chat-${++n}`,
      edited: new Set(),
      reads: new Map(),
      ask,
    };
    const tools = (await workerTools(config)).filter((t) => !CHAT_DENIED.has(t.name));
    const instructions = renderInstructions(await loadInstructions(jail.root, jail.root));
    const codemap = renderCodemap(
      await buildCodemap(jail.root),
      config.context.repo_map_max_tokens,
    );
    const system = [
      { text: CHAT_SYSTEM },
      ...(instructions ? [{ text: instructions }] : []),
      { text: codemap, cacheBreakpoint: true },
    ];
    return new CodeChat(config, deps.provider, tools, system, ctx, events, store);
  }

  /** One message: the agent works until it replies; `say` gets progress and the reply. */
  async send(
    text: string,
    say: (kind: 'out' | 'feed' | 'err', line: string) => void,
  ): Promise<void> {
    const b = brand({ env: {}, isTTY: true });
    const listener = (e: Parameters<typeof humanize>[0]) => {
      const line = humanize(e, { brand: b, verbosity: 'normal' });
      if (line && e.type === 'tool.call') say('feed', line);
    };
    this.events.onEvent(listener);
    this.ctx.edited.clear();
    this.ctx.reads?.clear();
    const result = await runAgentLoop(
      {
        system: this.system,
        history: this.history,
        first: { role: 'user', content: [{ type: 'text', text }] },
        tools: this.tools.map(toolSpec),
      },
      {
        provider: this.provider,
        models: resolveChain(this.config.models.worker, this.config),
        tools: this.tools,
        toolCtx: this.ctx,
        budget: this.config.budget,
        maxTokens: this.config.providers.anthropic.max_tokens,
        clock: realClock,
        events: this.events,
        spentUsd: () => this.usd,
        onUsage: (_u, usd) => {
          this.usd += usd;
          return Promise.resolve();
        },
        control: () => Promise.resolve('continue'),
      },
    );
    this.history = result.messages;
    if (result.finalText) say('out', result.finalText);
    if (result.end !== 'done') say('err', `(stopped: ${result.end})`);
    if (this.ctx.edited.size && this.config.gates.length) await this.check(say);
  }

  private async check(say: (kind: 'out' | 'feed' | 'err', line: string) => void): Promise<void> {
    const results = await runGates(this.config.gates, {
      cwd: this.ctx.jail.root,
      env: this.ctx.env,
      logsDir: this.store.logsDir,
      label: `chat${Date.now()}`,
      maxCmdTimeoutMs: this.ctx.maxCmdTimeoutMs,
      redact: (s) => this.ctx.redactor.text(s),
    });
    const line = results
      .map(
        (r) =>
          `${r.name} ${r.exitCode === 0 ? '✓' : `✗${r.failures.length ? ` (${r.failures.length})` : ''}`}`,
      )
      .join('  ');
    say(results.every((r) => r.exitCode === 0) ? 'feed' : 'err', `checks  ${line}`);
  }

  /** Forget the conversation (the codebase map and instructions stay). */
  clear(): void {
    this.history = [];
  }
}
