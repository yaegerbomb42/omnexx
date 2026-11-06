/**
 * The System-1 interceptor pipeline the agent loop calls into:
 *   prompt → intent/speculate → frontier LLM → guardrail + patch-sanity → tool → output triage
 *   → continuation check. Every hook is fail-open: a System-1 error never blocks the agent.
 */
import { readFile } from 'node:fs/promises';
import type { EventLog } from '../../core/events.js';
import { checkCommand } from '../../security/command-policy.js';
import type { ToolContext } from '../../tools/types.js';
import type { SystemOneClient } from './client.js';
import { assessCompletion, ContinuationTracker, type TurnCall } from './continuation.js';
import { assessCommand, blockedByUser, blockedUnattended, commandPreview } from './guardrail.js';
import {
  classifyIntent,
  speculate,
  speculativeBlock,
  type Runner,
  runCommand,
} from './intent-router.js';
import { needsTriage, triageOutput } from './output-triage.js';
import { assessPatch, rejectionMessage } from './patch-sanity.js';

export interface SystemOneSettings {
  destructiveThreshold: number;
  earlyStopThreshold: number;
  speculativeThreshold: number;
  patchPlaceholderThreshold: number;
  gates: {
    guardrail: boolean;
    earlyStop: boolean;
    outputTriage: boolean;
    speculativeRouting: boolean;
    patchSanity: boolean;
  };
}

/** Frontier tokens one avoided turn costs at least (the rest of the prompt is cache-read). */
const TURN_TOKENS = 4_000;
const WRITE_TOOLS = new Set(['str_replace', 'multi_edit', 'write_file', 'replace_lines']);

interface Patch {
  path: string;
  oldText: string;
  newText: string;
}

const rec = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
const s = (x: unknown): string => (typeof x === 'string' ? x : '');

async function currentText(ctx: ToolContext, path: string): Promise<string> {
  try {
    return await readFile(ctx.jail.resolve(path, 'read'), 'utf8');
  } catch {
    return '';
  }
}

/** What an edit tool call would replace, and with what. */
export async function patchOf(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<Patch | undefined> {
  const i = rec(input);
  const path = s(i.path);
  if (!path) return undefined;
  if (name === 'str_replace') return { path, oldText: s(i.old_str), newText: s(i.new_str) };
  if (name === 'multi_edit' && Array.isArray(i.edits)) {
    const edits = i.edits.map(rec);
    return {
      path,
      oldText: edits.map((e) => s(e.old_str)).join('\n'),
      newText: edits.map((e) => s(e.new_str)).join('\n'),
    };
  }
  if (name === 'write_file')
    return { path, oldText: await currentText(ctx, path), newText: s(i.content) };
  if (name === 'replace_lines') {
    const lines = (await currentText(ctx, path)).split('\n');
    const start = typeof i.start === 'number' ? i.start : 1;
    const end = typeof i.end === 'number' ? i.end : start;
    return { path, oldText: lines.slice(start - 1, end).join('\n'), newText: s(i.new_text) };
  }
  return undefined;
}

export class SystemOneMiddleware {
  private readonly tracker = new ContinuationTracker();
  private prompt = '';
  private backendLabel: string;

  constructor(
    readonly client: SystemOneClient,
    private readonly settings: SystemOneSettings,
    private readonly events: EventLog,
    private readonly repoRoot: string,
    private readonly run: Runner = runCommand,
  ) {
    this.backendLabel = client.label();
    events.emit('system1.backend', {
      label: this.backendLabel,
      model: client.model,
      backend: client.primary,
    });
  }

  /** Latency p50 for the next event; re-announces the backend once a probe changed it. */
  private p50(): number {
    const label = this.client.label();
    if (label !== this.backendLabel) {
      this.backendLabel = label;
      this.events.emit('system1.backend', {
        label,
        model: this.client.model,
        backend: this.client.primary,
      });
    }
    return Math.round(this.client.stats().latencyP50Ms * 100) / 100;
  }

  /** Gate 4: classify the prompt; for read-only investigations, pre-fetch the first search. */
  async onPrompt(prompt: string): Promise<string | undefined> {
    this.prompt = prompt;
    if (!this.settings.gates.speculativeRouting || !prompt.trim()) return undefined;
    try {
      const v = await classifyIntent(this.client, prompt);
      const investigative = v.intent === 'explain_code' || v.intent === 'git_operation';
      const findings =
        investigative && v.confidence >= this.settings.speculativeThreshold
          ? await speculate(v.intent, prompt, this.repoRoot, this.run)
          : undefined;
      this.events.emit('system1.intent', {
        intent: v.intent,
        confidence: v.confidence,
        speculated: Boolean(findings),
        tokensSaved: findings ? TURN_TOKENS : 0,
        backend: v.backend,
        latencyMs: v.latencyMs,
        p50Ms: this.p50(),
      });
      return findings ? speculativeBlock(v.intent, v.confidence, findings) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Gates 1 and 5: an error to return instead of running the tool, or undefined to go ahead. */
  async beforeTool(name: string, input: unknown, ctx: ToolContext): Promise<string | undefined> {
    try {
      if (name === 'bash' && this.settings.gates.guardrail) return await this.guard(input, ctx);
      if (WRITE_TOOLS.has(name) && this.settings.gates.patchSanity)
        return await this.checkPatch(name, input, ctx);
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async guard(input: unknown, ctx: ToolContext): Promise<string | undefined> {
    const command = s(rec(input).command);
    // The hard command policy runs first inside `bash` (and asks there when it can); System-1
    // covers what the policy lets through, so nothing is asked twice.
    if (!command || !checkCommand(command, ctx.policy).allowed) return undefined;
    const cwd = s(rec(input).cwd) || ctx.jail.root;
    const v = await assessCommand(
      this.client,
      { command, cwd, repoRoot: ctx.jail.root, allowOutsideRepo: false },
      this.settings.destructiveThreshold,
    );
    let blocked = false;
    let prompted = false;
    if (v.destructive) {
      if (ctx.ask) {
        prompted = true;
        blocked = !(await ctx.ask(
          `Run \`${commandPreview(command)}\`? System-1 flags it as destructive (prob ${v.prob.toFixed(2)}).`,
        ));
      } else blocked = true;
    }
    this.events.emit('system1.guardrail', {
      commandPreview: commandPreview(command),
      prob: v.prob,
      blocked,
      prompted,
      backend: v.backend,
      latencyMs: v.latencyMs,
      p50Ms: this.p50(),
    });
    if (!blocked) return undefined;
    return prompted ? blockedByUser(v.prob) : blockedUnattended(v.prob);
  }

  private async checkPatch(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<string | undefined> {
    const patch = await patchOf(name, input, ctx);
    if (!patch) return undefined;
    const v = await assessPatch(this.client, patch, this.settings.patchPlaceholderThreshold);
    this.events.emit('system1.patch_sanity', {
      path: patch.path,
      rejected: v.reject,
      placeholderProb: v.placeholderProb,
      completeness: v.completeness,
      backend: v.backend,
      latencyMs: v.latencyMs,
      p50Ms: this.p50(),
    });
    return v.reject ? rejectionMessage(patch.path, v) : undefined;
  }

  /** Gate 3: the tool result as it should enter the conversation. */
  async afterTool(name: string, content: string): Promise<string> {
    if (!this.settings.gates.outputTriage || name !== 'bash' || !needsTriage(content))
      return content;
    try {
      const r = await triageOutput(this.client, content, name);
      this.events.emit('system1.triage', {
        tool: name,
        changed: r.changed,
        linesPruned: r.linesPruned,
        warningLines: r.warningLines,
        tokensSaved: r.tokensSaved,
        backend: r.backend,
        latencyMs: r.latencyMs,
        p50Ms: this.p50(),
      });
      return r.content;
    } catch {
      return content;
    }
  }

  /**
   * Gate 2: when the request is done and the loop is only re-inspecting, the closing reply to end
   * on (the model's own summary when it wrote one); undefined to keep going.
   */
  async afterTurn(
    calls: readonly TurnCall[],
    assistantText: string,
    turn: number,
  ): Promise<string | undefined> {
    this.tracker.record(calls, assistantText);
    if (!this.settings.gates.earlyStop || !this.tracker.eligible(assistantText)) return undefined;
    try {
      const v = await assessCompletion(
        this.client,
        this.tracker.state(this.prompt, assistantText),
        this.settings.earlyStopThreshold,
      );
      if (!v.stop) return undefined;
      this.events.emit('system1.early_stop', {
        turn,
        prob: v.prob,
        tokensSaved: TURN_TOKENS,
        filesModified: this.tracker.filesModified.size,
        backend: v.backend,
        latencyMs: v.latencyMs,
        p50Ms: this.p50(),
      });
      return this.closingReply(assistantText);
    } catch {
      return undefined;
    }
  }

  private closingReply(assistantText: string): string {
    if (assistantText.trim().length >= 200) return assistantText.trim();
    const files = [...this.tracker.filesModified].sort((a, b) => a.localeCompare(b));
    const changed = files.length
      ? `Changed ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` and ${String(files.length - 8)} more` : ''}; the checks passed after the last edit.`
      : 'Answered above.';
    return `${assistantText.trim() ? `${assistantText.trim()}\n\n` : ''}Done. ${changed}`;
  }
}
