import type { Message } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { StateCheckpointer, pathsFromToolInput } from './checkpoint.js';
import { CapabilityIndex, LocalMetaRouter } from './ollamaRouter.js';
import { TelemetryMonitor, classifyToolError, type ToolObservation } from './telemetry.js';
import type { ModelProfileHints, TelemetrySnapshot, TurnAllocation } from './types.js';
import { isMutatingTool } from './types.js';

export interface KernelConfig {
  enabled: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  embedModel: string;
  attentionCeiling: number;
  worktree: string;
  /** Active model context window (tokens). */
  maxWindow: number;
  /** Soft tool-mount cap for the active model class. */
  maxMountedTools?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface TurnPlan {
  allocation: TurnAllocation;
  /** Tools the loop should expose this turn (subset of the full registry). */
  tools: readonly Tool[];
  /** Cap for this turn's max_tokens. */
  maxTokens: number;
  /** Compact system hint describing roles / reasoning mode. */
  systemHint: string;
  telemetry: TelemetrySnapshot;
}

export interface KernelToolEvent {
  tool: string;
  input: unknown;
  isError: boolean;
  content: string;
  /** Estimated next-prompt tokens, when known. */
  promptTokens?: number | undefined;
  /** Positive when a mutating tool succeeded and changed state. */
  stateProgress?: number | undefined;
}

/**
 * Adaptive Runtime Kernel facade. Construct only when `[kernel].enabled` is true;
 * the agent loop stays unchanged when this is absent.
 */
export class AdaptiveRuntimeKernel {
  readonly telemetry: TelemetryMonitor;
  readonly checkpointer: StateCheckpointer;
  readonly index: CapabilityIndex;
  readonly router: LocalMetaRouter;
  private lastAllocation: TurnAllocation | undefined;
  private lastCheckpointId: string | undefined;
  private turnCounter = 0;

  constructor(config: KernelConfig) {
    const profile: ModelProfileHints = {
      maxWindow: config.maxWindow,
      attentionCeiling: config.attentionCeiling,
      maxMountedTools: config.maxMountedTools ?? 8,
    };
    this.telemetry = new TelemetryMonitor(profile);
    this.checkpointer = new StateCheckpointer({ worktree: config.worktree });
    const ollama = {
      baseUrl: config.ollamaUrl,
      chatModel: config.ollamaModel,
      embedModel: config.embedModel,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    };
    this.index = new CapabilityIndex(ollama);
    this.router = new LocalMetaRouter({ ...ollama, index: this.index });
  }

  /** Index tools + skills once at cycle/chat start. */
  async warm(
    tools: readonly { name: string; description: string }[],
    skills: readonly { name: string; description: string; triggerConditions?: string }[] = [],
  ): Promise<void> {
    await this.index.index(tools, skills);
  }

  /**
   * Plan the next turn: telemetry snapshot → top-K capabilities → allocation → filtered tools.
   */
  async planTurn(args: {
    objective: string;
    stateDelta?: string | undefined;
    allTools: readonly Tool[];
    promptTokens?: number | undefined;
    defaultMaxTokens: number;
  }): Promise<TurnPlan> {
    this.turnCounter += 1;
    this.telemetry.beginTurn(this.turnCounter);
    if (args.promptTokens !== undefined) this.telemetry.setPromptTokens(args.promptTokens);

    if (this.telemetry.needsCompaction()) {
      // Tier-3 signal: still allocate, but force GC-lean budgets.
    }

    const telemetry = this.telemetry.snapshot();
    const query = `${args.objective}\n${args.stateDelta ?? ''}`;
    const candidates = await this.index.search(query, 10);
    const allocation = await this.router.allocate({
      objective: args.objective,
      stateDelta: args.stateDelta ?? '',
      telemetry,
      candidates,
      profile: {
        maxWindow: 1, // unused in allocate path beyond profile.maxMountedTools
        attentionCeiling: 0.65,
        maxMountedTools: Math.min(args.allTools.length, telemetry.contextPressure > 0.8 ? 5 : 8),
      },
    });

    // Always keep core navigation tools even if the router narrowed the mount set.
    const essential = new Set(['read', 'search', 'outline', 'bash', 'str_replace', 'write_file']);
    const mounted = new Set(allocation.mountedTools);
    const filtered =
      mounted.size === 0
        ? args.allTools
        : args.allTools.filter((t) => mounted.has(t.name) || essential.has(t.name));

    const maxTokens = Math.min(args.defaultMaxTokens, allocation.maxTokensTurn);
    this.lastAllocation = allocation;

    return {
      allocation,
      tools: filtered,
      maxTokens,
      systemHint: formatSystemHint(allocation),
      telemetry,
    };
  }

  /** Snapshot before a mutating tool. Returns the checkpoint node id. */
  async beforeMutatingTool(
    toolName: string,
    input: unknown,
    conversationLength: number,
  ): Promise<string | undefined> {
    if (!isMutatingTool(toolName)) return undefined;
    const nodeId = `t${this.turnCounter}-${toolName}-${conversationLength}`;
    await this.checkpointer.snapshot(nodeId, conversationLength, pathsFromToolInput(input));
    this.lastCheckpointId = nodeId;
    return nodeId;
  }

  /** Update telemetry after a tool result; optionally trigger rollback. */
  async afterTool(
    event: KernelToolEvent,
    messages: Message[],
  ): Promise<{ messages: Message[]; constraint?: string } | undefined> {
    const obs: ToolObservation = {
      tool: event.tool,
      inputSummary: summarizeInput(event.input),
      isError: event.isError,
      kind: event.isError ? classifyToolError(event.content) : undefined,
      ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
      ...(event.stateProgress !== undefined ? { stateProgress: event.stateProgress } : {}),
    };
    this.telemetry.observeTool(obs);

    if (!this.telemetry.shouldRollback() || !this.lastCheckpointId) return undefined;

    const reason = event.isError
      ? event.content.slice(0, 120).replace(/\s+/g, ' ')
      : `friction=${this.telemetry.snapshot().frictionScore}`;
    const result = await this.checkpointer.rollbackToCheckpoint(this.lastCheckpointId, reason);
    this.lastCheckpointId = undefined;
    this.telemetry.observeTool({
      tool: 'kernel_rollback',
      inputSummary: result.nodeId,
      isError: false,
      stateProgress: 1,
    });

    const pruned =
      result.pruneAfter > 0 && result.pruneAfter < messages.length
        ? messages.slice(0, result.pruneAfter)
        : messages;
    return { messages: pruned, constraint: result.constraint };
  }

  get allocation(): TurnAllocation | undefined {
    return this.lastAllocation;
  }
}

function formatSystemHint(a: TurnAllocation): string {
  const roles = a.activeRoles.join('+');
  const bits = [
    `[kernel] tier=${a.tier}`,
    `mode=${a.reasoningMode}`,
    `roles=${roles}`,
    `blast=${a.blastRadius}`,
  ];
  if (a.mctsBranchFactor) bits.push(`mcts_k=${a.mctsBranchFactor}`);
  if (a.mountedSkills.length) bits.push(`skills=${a.mountedSkills.join(',')}`);
  if (a.allowCodeModeBatching) bits.push('batch=on');
  return bits.join(' ');
}

function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 80);
  } catch {
    return String(input).slice(0, 80);
  }
}

/** Build a kernel from config when enabled; otherwise undefined (zero behavior change). */
export function createKernelIfEnabled(
  config: {
    kernel?: {
      enabled: boolean;
      ollama_url: string;
      ollama_model: string;
      embed_model: string;
      attention_ceiling: number;
    };
  },
  worktree: string,
  maxWindow: number,
  fetchImpl?: typeof fetch,
): AdaptiveRuntimeKernel | undefined {
  const k = config.kernel;
  if (!k?.enabled) return undefined;
  return new AdaptiveRuntimeKernel({
    enabled: true,
    ollamaUrl: k.ollama_url,
    ollamaModel: k.ollama_model,
    embedModel: k.embed_model,
    attentionCeiling: k.attention_ceiling,
    worktree,
    maxWindow,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
