import type { Message } from '../../providers/types.js';
import type { Tool } from '../../tools/types.js';
import { CapabilityCatalog, createCatalogTools, type CatalogEntry } from './catalog.js';
import { StateCheckpointer, pathsFromToolInput } from './checkpoint.js';
import { ContextGarbageCollector, compactAsync } from './contextGc.js';
import { discoverLocalMcpServers, discoverLocalSkills, searchSkillMd } from './discover.js';
import {
  mcpServerKeyFromCatalogId,
  skillNameFromCatalogId,
  type CapabilityRuntime,
} from './liveMount.js';
import { runMcts } from './mcts.js';
import {
  CapabilityIndex,
  LocalMetaRouter,
  allocationSimilarities,
  multiSampleAllocations,
} from './ollamaRouter.js';
import { installSuggestion, loadRegistry, type RegistryServerRecord } from './registry.js';
import { TelemetryMonitor, classifyToolError, type ToolObservation } from './telemetry.js';
import type { ModelProfileHints, TelemetrySnapshot, TurnAllocation } from './types.js';
import { isMutatingTool, isNoOpToolInput } from './types.js';
import { MemoryVfs } from './vfs.js';

export interface KernelConfig {
  enabled: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  embedModel: string;
  attentionCeiling: number;
  worktree: string;
  maxWindow: number;
  /** @deprecated alias of `maxMounted` (used only when `maxMounted` is unset). */
  maxMountedTools?: number | undefined;
  /** Single cap for mounted catalog capabilities AND router-mounted tools (`[kernel] max_mounted`). */
  maxMounted?: number | undefined;
  reselectEvery?: number | undefined;
  registry?: boolean | undefined;
  localDiscovery?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Skip live registry network (tests). */
  offlineRegistry?: boolean | undefined;
  /** Enrich search_capabilities with SkillMD public index (default true). */
  publicSkills?: boolean | undefined;
  /**
   * Max ms the loop waits for the lazy first-turn warm (default 5000, 0 = wait forever).
   * The warm keeps running in the background past the budget, so the catalog still lands.
   */
  warmTimeoutMs?: number | undefined;
  /** Extra tool names never filtered out at tier>=2 (e.g. a project's primary MCP editor). */
  essentialTools?: readonly string[] | undefined;
  /** Lazy-connect MCP servers + page skill bodies when catalog mounts them. */
  mcpRuntime?: CapabilityRuntime | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface TurnPlan {
  allocation: TurnAllocation;
  tools: readonly Tool[];
  maxTokens: number;
  systemHint: string;
  telemetry: TelemetrySnapshot;
  /** Present when tier-3 GC compacted the conversation this turn. */
  compactedMessages?: Message[] | undefined;
  /** MCTS selected branch id when tier/mode used search. */
  mctsSelectedId?: string | undefined;
  /** Catalog capabilities currently mounted (ids). */
  mountedCapabilities?: string[] | undefined;
  /** Caller tools removed by the tier>=2 filter this turn (empty when nothing was dropped). */
  droppedTools?: string[] | undefined;
  /** The lazy warm outran its budget; the turn ran without the full catalog. */
  warmTimedOut?: boolean | undefined;
}

export interface KernelToolEvent {
  tool: string;
  input: unknown;
  isError: boolean;
  content: string;
  promptTokens?: number | undefined;
  stateProgress?: number | undefined;
}

/**
 * Adaptive Runtime Kernel. Default-on; degrades to pure heuristics within ~80ms when
 * Ollama is absent so a normal run is never blocked.
 */
/** Normalize an MCP server name to a comparable short key (`io.github.x/server-filesystem` → `filesystem`). */
export function normalizeMcpServerName(name: string): string {
  const last = name.toLowerCase().split(/[/:]/).pop() ?? '';
  return last
    .replace(/^@/, '')
    .replace(/^(mcp[-_]server[-_]|server[-_]|mcp[-_])/, '')
    .replace(/([-_]mcp[-_]server|[-_]server|[-_]mcp)$/, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * True when a registry server is (very likely) the same server as a locally configured one.
 * Registry names are namespaced (`owner/pkg`) while local config keys are short (`filesystem`).
 */
export function registryMirrorsLocal(
  registryServer: string,
  installIdentifier: string | undefined,
  localNames: readonly string[],
): boolean {
  if (localNames.length === 0) return false;
  const keys = new Set([normalizeMcpServerName(registryServer)]);
  if (installIdentifier) keys.add(normalizeMcpServerName(installIdentifier));
  keys.delete('');
  return localNames.some((l) => l === registryServer || keys.has(normalizeMcpServerName(l)));
}

/** Navigation + editing tools always kept when a deliberative tier narrows the tool set. */
export const DEFAULT_ESSENTIAL_TOOLS: readonly string[] = [
  'read',
  'search',
  'outline',
  'bash',
  'str_replace',
  'write_file',
  'multi_edit',
  'apply_patch',
  'edit',
];

/** One resolved mount cap for both the catalog and the router (`maxMounted` wins). */
export function resolveMaxMounted(config: {
  maxMounted?: number | undefined;
  maxMountedTools?: number | undefined;
}): number {
  return config.maxMounted ?? config.maxMountedTools ?? 8;
}

/** Default max ms the first turn waits on the lazy catalog warm. */
export const DEFAULT_WARM_TIMEOUT_MS = 5_000;

export class AdaptiveRuntimeKernel {
  readonly telemetry: TelemetryMonitor;
  readonly checkpointer: StateCheckpointer;
  readonly index: CapabilityIndex;
  readonly router: LocalMetaRouter;
  readonly vfs: MemoryVfs;
  readonly gc: ContextGarbageCollector;
  readonly catalog: CapabilityCatalog;
  private readonly config: KernelConfig;
  private readonly registryById = new Map<string, RegistryServerRecord>();
  private readonly localInstalled = new Set<string>();
  private catalogTools: Tool[] = [];
  /** Live Tools injected for currently mounted MCP servers (key = server name). */
  private liveMcpTools = new Map<string, Tool[]>();
  /** Skill bodies paged into context for currently mounted skills (key = catalog id). */
  private pagedSkills = new Map<string, string>();
  private lastAllocation: TurnAllocation | undefined;
  private lastCheckpointId: string | undefined;
  private turnCounter = 0;
  private currentTaskKey = '';
  private profile: ModelProfileHints;
  private warmed = false;
  /** In-flight warm, shared so one registry fetch serves every caller. */
  private warmInFlight: Promise<void> | undefined;

  constructor(config: KernelConfig) {
    this.config = config;
    this.profile = {
      maxWindow: config.maxWindow,
      attentionCeiling: config.attentionCeiling,
      maxMountedTools: resolveMaxMounted(config),
    };
    this.telemetry = new TelemetryMonitor(this.profile);
    this.vfs = new MemoryVfs(config.worktree);
    this.checkpointer = new StateCheckpointer({ worktree: config.worktree, vfs: this.vfs });
    this.gc = new ContextGarbageCollector();
    this.catalog = new CapabilityCatalog();
    const ollama = {
      baseUrl: config.ollamaUrl,
      chatModel: config.ollamaModel,
      embedModel: config.embedModel,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    };
    this.index = new CapabilityIndex(ollama);
    this.router = new LocalMetaRouter({ ...ollama, index: this.index });
    this.rebuildCatalogTools();
  }

  private rebuildCatalogTools(): void {
    const maxMounted = resolveMaxMounted(this.config);
    this.catalogTools = createCatalogTools(this.catalog, {
      maxMounted,
      isInstalled: (id) => this.localInstalled.has(id) || id.startsWith('local:'),
      suggestInstall: (id, entry) => {
        const rec = this.registryById.get(id);
        if (rec) return installSuggestion(rec);
        if (id.startsWith('registry:skill:')) {
          const slug = id.slice('registry:skill:'.length);
          return (
            `Skill "${entry.name}" (${slug}) is listed on SkillMD but not installed locally. ` +
            `Install with: npx skillmds@latest add ${slug}  — then remount. ` +
            `Omnexx will not auto-install or run untrusted skill code.`
          );
        }
        return `Capability "${id}" is not installed locally. Configure it in Omnexx MCP settings first; Omnexx will not auto-install or run untrusted code.`;
      },
      ...(this.config.publicSkills === false
        ? {}
        : {
            publicSkillSearch: (query: string, limit: number) =>
              searchSkillMd(query, {
                limit,
                ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
              }),
          }),
      onMount: (entry) => this.activateLiveMount(entry),
      onUnmount: async (id) => {
        await this.dropLiveMount(id);
      },
    });
  }

  /** Tools currently injected from live-mounted MCP servers. */
  getLiveMcpTools(): readonly Tool[] {
    return [...this.liveMcpTools.values()].flat();
  }

  /** Skill pages currently in context. */
  getPagedSkills(): ReadonlyMap<string, string> {
    return this.pagedSkills;
  }

  /** Wire or replace the MCP/skill runtime used for live mounts (call after tool sources load). */
  attachMcpRuntime(runtime: CapabilityRuntime): void {
    (this.config as { mcpRuntime?: CapabilityRuntime }).mcpRuntime = runtime;
    this.rebuildCatalogTools();
  }

  /**
   * Lazy-connect an MCP server (or page a skill body) for a mounted catalog entry.
   * Returns a short status string for the mount_capability tool result.
   */
  async activateLiveMount(entry: CatalogEntry): Promise<string | undefined> {
    const runtime = this.config.mcpRuntime;
    if (
      entry.kind === 'mcp' ||
      entry.id.startsWith('local:mcp:') ||
      entry.id.startsWith('registry:mcp:')
    ) {
      const server = mcpServerKeyFromCatalogId(entry.id, entry.server);
      if (!server) return 'No MCP server key on catalog entry.';
      if (!runtime?.loadMcpServerTools) {
        return (
          `Catalog mounted ${entry.id}, but no MCP runtime is wired — configure the server in Omnexx ` +
          `and pass mcpRuntime so tools can be injected.`
        );
      }
      if (runtime.hasMcpServer && !runtime.hasMcpServer(server)) {
        throw new Error(`MCP server "${server}" is not configured locally (cannot lazy-connect).`);
      }
      const tools = await runtime.loadMcpServerTools(server);
      this.liveMcpTools.set(server, [...tools]);
      // Attach first tool schema onto the catalog header for search display.
      const first = tools[0];
      if (first) {
        this.catalog.upsert([
          {
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            description: entry.description,
            server,
            inputSchema: {
              type: 'object',
              properties: {
                note: {
                  type: 'string',
                  description: `Live tools: ${tools.map((t) => t.name).join(', ')}`,
                },
              },
            },
          },
        ]);
      }
      return `Live MCP tools injected (${tools.length}): ${tools.map((t) => t.name).join(', ') || '(none)'}`;
    }

    if (entry.kind === 'skill' || entry.id.includes(':skill:')) {
      const skillName = skillNameFromCatalogId(entry.id, entry.name);
      if (!skillName) return undefined;
      if (!runtime?.loadSkillBody) {
        this.pagedSkills.set(
          entry.id,
          `# Skill: ${entry.name}

${entry.description}`,
        );
        return 'Skill description paged into context (no skill loader).';
      }
      const body = await runtime.loadSkillBody(skillName);
      const page =
        body ??
        `# Skill: ${entry.name}

${entry.description}`;
      this.pagedSkills.set(entry.id, page);
      return `Skill "${skillName}" paged into context (${page.length} chars).`;
    }
    return undefined;
  }

  async dropLiveMount(id: string): Promise<void> {
    const entry = this.catalog.get(id);
    const server = mcpServerKeyFromCatalogId(id, entry?.server);
    if (server) this.liveMcpTools.delete(server);
    this.pagedSkills.delete(id);
  }

  /** Ensure live tools/skills match the catalog mount set (after select / reselect). */
  async syncLiveMounts(): Promise<void> {
    const mounted = this.catalog.getMounted();
    const wantedServers = new Set<string>();
    const wantedSkillIds = new Set<string>();

    for (const e of mounted) {
      if (e.kind === 'mcp' || e.id.startsWith('local:mcp:') || e.id.startsWith('registry:mcp:')) {
        const server = mcpServerKeyFromCatalogId(e.id, e.server);
        if (!server) continue;
        wantedServers.add(server);
        if (!this.liveMcpTools.has(server)) {
          try {
            await this.activateLiveMount(e);
          } catch {
            // leave unmounted live; model still has catalog header
          }
        }
      } else if (e.kind === 'skill' || e.id.includes(':skill:')) {
        wantedSkillIds.add(e.id);
        if (!this.pagedSkills.has(e.id)) {
          try {
            await this.activateLiveMount(e);
          } catch {
            // ignore
          }
        }
      }
    }

    for (const server of [...this.liveMcpTools.keys()]) {
      if (!wantedServers.has(server)) this.liveMcpTools.delete(server);
    }
    for (const id of [...this.pagedSkills.keys()]) {
      if (!wantedSkillIds.has(id)) this.pagedSkills.delete(id);
    }
  }

  /**
   * Index native tools/skills AND the real capability catalog (MCP Registry + local
   * MCP configs + on-disk skills). Registry fetch is bounded and falls back to the
   * bundled snapshot offline. Concurrent callers share one warm.
   */
  async warm(
    tools: readonly { name: string; description: string }[],
    skills: readonly { name: string; description: string; triggerConditions?: string }[] = [],
  ): Promise<void> {
    const inFlight = this.warmInFlight;
    if (inFlight) return inFlight;
    const run = this.runWarm(tools, skills);
    this.warmInFlight = run;
    try {
      await run;
    } finally {
      if (this.warmInFlight === run) this.warmInFlight = undefined;
    }
  }

  private async runWarm(
    tools: readonly { name: string; description: string }[],
    skills: readonly { name: string; description: string; triggerConditions?: string }[],
  ): Promise<void> {
    await this.index.index(tools, skills);

    const catalogEntries: Omit<CatalogEntry, 'tokens'>[] = [];

    // Native worker tools as always-available local capabilities (for search, not double-mounted).
    for (const t of tools) {
      catalogEntries.push({
        id: `local:tool:${t.name}`,
        kind: 'tool',
        name: t.name,
        description: t.description,
      });
      this.localInstalled.add(`local:tool:${t.name}`);
    }
    for (const s of skills) {
      const e: Omit<CatalogEntry, 'tokens'> = {
        id: `local:skill:${s.name}`,
        kind: 'skill',
        name: s.name,
        description: s.description,
      };
      if (s.triggerConditions !== undefined) e.triggerConditions = s.triggerConditions;
      catalogEntries.push(e);
      this.localInstalled.add(`local:skill:${s.name}`);
    }

    if (this.config.localDiscovery !== false) {
      const mcp = await discoverLocalMcpServers({
        repoRoot: this.config.worktree,
        ...(this.config.env ? { env: this.config.env } : {}),
      });
      for (const e of mcp.entries) {
        catalogEntries.push(e);
        this.localInstalled.add(e.id);
      }
      const sk = await discoverLocalSkills({
        repoRoot: this.config.worktree,
        ...(this.config.env ? { env: this.config.env } : {}),
      });
      for (const e of sk.entries) {
        catalogEntries.push(e);
        this.localInstalled.add(e.id);
      }
    }

    if (this.config.registry !== false) {
      const reg = await loadRegistry({
        ...(this.config.env ? { env: this.config.env } : {}),
        ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
        offline: this.config.offlineRegistry === true,
      });
      for (const s of reg.snapshot.servers) this.registryById.set(s.id, s);
      // Registry entries are searchable but NOT installed unless a local mirror exists.
      const localMcpNames = [...this.localInstalled]
        .filter((id) => id.startsWith('local:mcp:'))
        .map((id) => id.slice('local:mcp:'.length));
      for (const e of reg.entries) {
        const rec = this.registryById.get(e.id);
        if (registryMirrorsLocal(e.server ?? e.name, rec?.install?.identifier, localMcpNames)) {
          // Already have a local install of that server — skip duplicate registry row.
          continue;
        }
        catalogEntries.push(e);
      }
    }

    this.catalog.load(catalogEntries);
    this.rebuildCatalogTools();
    this.warmed = true;
  }

  /**
   * Wait for the warm, but never longer than the budget. Returns false when the
   * budget expires first (the warm keeps running in the background).
   */
  private async awaitWarmBudget(warm: Promise<void>): Promise<boolean> {
    const budget = this.config.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
    if (!Number.isFinite(budget) || budget <= 0) {
      await warm;
      return true;
    }
    type Outcome = { status: 'ok' } | { status: 'error'; error: unknown } | { status: 'timeout' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timeout' });
      }, budget);
    });
    const outcome = await Promise.race<Outcome>([
      warm.then(
        (): Outcome => ({ status: 'ok' }),
        (error: unknown): Outcome => ({ status: 'error', error }),
      ),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.status === 'error') throw outcome.error;
    return outcome.status === 'ok';
  }

  async planTurn(args: {
    objective: string;
    stateDelta?: string | undefined;
    allTools: readonly Tool[];
    promptTokens?: number | undefined;
    defaultMaxTokens: number;
    messages?: readonly Message[] | undefined;
    /** In-memory skills known to the caller; indexed alongside on-disk skills on warm. */
    skills?:
      readonly { name: string; description: string; triggerConditions?: string }[] | undefined;
  }): Promise<TurnPlan> {
    this.turnCounter += 1;
    this.telemetry.beginTurn(this.turnCounter);
    if (args.promptTokens !== undefined) this.telemetry.setPromptTokens(args.promptTokens);

    const query = `${args.objective}\n${args.stateDelta ?? ''}`;

    // Dynamic capability loading — re-select mounted MCP/skills from the large catalog.
    let warmTimedOut = false;
    if (!this.warmed) {
      const warm = this.warm(
        args.allTools.map((t) => ({ name: t.name, description: t.description })),
        args.skills ?? [],
      );
      // A slow registry must not stall the first model call: wait at most the warm
      // budget, then let the warm finish in the background (catalog lands next turn).
      warmTimedOut = !(await this.awaitWarmBudget(warm));
    }
    const taskKey = args.objective.slice(0, 160);
    const newTask = taskKey !== this.currentTaskKey && taskKey.length > 0;
    if (newTask) this.currentTaskKey = taskKey;
    const telSnapEarly = this.telemetry.snapshot();
    const needsInitialSelect =
      this.catalog.mountedCount === 0 && (newTask || this.turnCounter <= 1);
    if (
      this.catalog.size > 0 &&
      (needsInitialSelect ||
        this.catalog.shouldReselect({
          everyNTurns: this.config.reselectEvery ?? 4,
          frictionScore: telSnapEarly.frictionScore,
          newTask,
        }))
    ) {
      this.catalog.select({
        query,
        maxMounted: resolveMaxMounted(this.config),
        pin: this.catalog
          .getMountedIds()
          .filter((id) => id.startsWith('local:tool:'))
          .slice(0, 4),
      });
    }
    await this.syncLiveMounts();

    const candidates =
      this.catalog.size > 0
        ? this.catalog.search(query, 10).map((e) => ({
            kind: (e.kind === 'skill' ? 'skill' : 'tool') as 'tool' | 'skill',
            id: e.id,
            name: e.name,
            description: e.description,
            tokens: e.tokens,
          }))
        : this.index.usingEmbeddings
          ? await this.index.search(query, 10)
          : this.index.tfidfSearch(query, 10);

    const telemetryBefore = this.telemetry.snapshot();
    const baseReq = {
      objective: args.objective,
      stateDelta: args.stateDelta ?? '',
      telemetry: telemetryBefore,
      candidates,
      profile: {
        maxWindow: this.profile.maxWindow,
        attentionCeiling: this.profile.attentionCeiling,
        maxMountedTools: Math.min(
          args.allTools.length,
          telemetryBefore.contextPressure > 0.8 ? 5 : this.profile.maxMountedTools,
        ),
      },
    };

    // Allocate against the pre-divergence snapshot so multi-sample noise cannot
    // escalate the current turn's tier (divergence informs the *next* turn).
    let allocation = await this.router.allocate(baseReq);

    const samples = multiSampleAllocations(baseReq, candidates, 3);
    // Applied only after this turn's plan is fixed (see below) — no same-turn bleed.
    const sims = allocationSimilarities(samples);

    let mctsSelectedId: string | undefined;
    if (allocation.tier === 2 || allocation.reasoningMode === 'mcts') {
      const mcts = runMcts({
        seed: allocation,
        objective: args.objective,
        telemetry: telemetryBefore,
        candidates,
        options: { branchFactor: allocation.mctsBranchFactor ?? 3 },
      });
      // Never downgrade: a tier-3 seed that entered via reasoningMode 'mcts' keeps tier 3 (GC).
      const tier = Math.max(2, allocation.tier) as 2 | 3;
      allocation = { ...mcts.best, tier, reasoningMode: 'mcts' };
      if (!allocation.mctsBranchFactor)
        allocation.mctsBranchFactor = mcts.best.mctsBranchFactor ?? 3;
      mctsSelectedId = mcts.selectedId;
    }

    // Tier-3 / pressure: run context GC (sync fingerprint path; optional async follow-up).
    let compactedMessages: Message[] | undefined;
    if (
      (allocation.tier === 3 || this.telemetry.needsCompaction()) &&
      args.messages &&
      args.messages.length > 6
    ) {
      const result = this.gc.compact(args.messages, {
        keepRecent: 4,
        targetTokens: Math.floor(this.profile.maxWindow * this.profile.attentionCeiling * 0.5),
      });
      if (result.removed > 0) {
        compactedMessages = result.messages;
        allocation = {
          ...allocation,
          tier: 3,
          maxTokensTurn: Math.min(allocation.maxTokensTurn, 400),
        };
      }
      // Fire-and-forget async re-pass so GC work can overlap the model call.
      void compactAsync(this.gc, args.messages, { keepRecent: 4 });
    }

    // Tier 0 fast-path: expose every tool (zero behavior change vs pre-kernel). Higher
    // tiers JIT-mount a subset plus a small essential set so the model can still navigate.
    const essential = new Set([...DEFAULT_ESSENTIAL_TOOLS, ...(this.config.essentialTools ?? [])]);
    const mounted = new Set(allocation.mountedTools);
    const filtered =
      allocation.tier < 2 || mounted.size === 0
        ? args.allTools
        : args.allTools.filter((t) => mounted.has(t.name) || essential.has(t.name));

    const keptNames = new Set(filtered.map((t) => t.name));
    const dropped = args.allTools.filter((t) => !keptNames.has(t.name)).map((t) => t.name);

    // Tier 0/1 must not shrink the caller's max_tokens — that alone changed chat/cycle
    // behavior under default-on. Deliberative tiers may throttle.
    const maxTokens =
      allocation.tier >= 2
        ? Math.min(args.defaultMaxTokens, allocation.maxTokensTurn)
        : args.defaultMaxTokens;
    this.lastAllocation = allocation;
    const telemetry = this.telemetry.snapshot();
    // Divergence informs the *next* turn only.
    if (sims.length) this.telemetry.observeDivergence(sims);

    // Native/filtered tools first (stable unknown-tool messages), then meta-tools,
    // then live-injected MCP tools from mounted catalog capabilities.
    const liveInjected = this.getLiveMcpTools();
    const reserved = new Set([
      ...this.catalogTools.map((t) => t.name),
      ...liveInjected.map((t) => t.name),
    ]);
    const mergedTools = [
      ...filtered.filter((t) => !reserved.has(t.name)),
      ...this.catalogTools,
      ...liveInjected,
    ];

    return {
      allocation,
      tools: mergedTools,
      maxTokens,
      systemHint: formatSystemHint(allocation, mctsSelectedId, this.pagedSkills),
      telemetry,
      ...(compactedMessages ? { compactedMessages } : {}),
      ...(mctsSelectedId ? { mctsSelectedId } : {}),
      ...(warmTimedOut ? { warmTimedOut: true } : {}),
      ...(dropped.length ? { droppedTools: dropped } : {}),
    };
  }

  async beforeMutatingTool(
    toolName: string,
    input: unknown,
    conversationLength: number,
  ): Promise<string | undefined> {
    if (!isMutatingTool(toolName) || isNoOpToolInput(input)) return undefined;
    const paths = pathsFromToolInput(input);
    await this.vfs.ingestMany(paths);
    const nodeId = `t${this.turnCounter}-${toolName}-${conversationLength}`;
    await this.checkpointer.snapshot(nodeId, conversationLength, paths);
    this.lastCheckpointId = nodeId;
    return nodeId;
  }

  async afterTool(
    event: KernelToolEvent,
    messages: Message[],
  ): Promise<{ messages: Message[]; constraint?: string } | undefined> {
    const paths = pathsFromToolInput(event.input);
    if (paths.length && !event.isError) await this.vfs.ingestMany(paths);

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

function formatSystemHint(
  a: TurnAllocation,
  mctsId?: string,
  pagedSkills?: ReadonlyMap<string, string>,
): string {
  const roles = a.activeRoles.join('+');
  const bits = [
    `[kernel] tier=${a.tier}`,
    `mode=${a.reasoningMode}`,
    `roles=${roles}`,
    `blast=${a.blastRadius}`,
  ];
  if (a.mctsBranchFactor) bits.push(`mcts_k=${a.mctsBranchFactor}`);
  if (mctsId) bits.push(`mcts_pick=${mctsId}`);
  if (a.mountedSkills.length) bits.push(`skills=${a.mountedSkills.join(',')}`);
  if (a.allowCodeModeBatching) bits.push('batch=on');
  let hint = bits.join(' ');
  if (pagedSkills && pagedSkills.size > 0) {
    const pages = [...pagedSkills.entries()]
      .map(([id, body]) => `--- mounted skill ${id} ---\n${body}`)
      .join('\n\n');
    hint += `\n\n[kernel:skills]\n${pages}`;
  }
  return hint;
}

function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 80);
  } catch {
    return String(input).slice(0, 80);
  }
}

/** Build a kernel unless explicitly disabled. */
export function createKernelIfEnabled(
  config: {
    kernel?: {
      enabled: boolean;
      ollama_url: string;
      ollama_model: string;
      embed_model: string;
      attention_ceiling: number;
      max_mounted?: number;
      reselect_every?: number;
      registry?: boolean;
      local_discovery?: boolean;
      public_skills?: boolean;
    };
  },
  worktree: string,
  maxWindow: number,
  fetchImpl?: typeof fetch,
): AdaptiveRuntimeKernel | undefined {
  const k = config.kernel;
  // Default-on: missing section still enables via schema defaults; explicit false opts out.
  if (k?.enabled === false) return undefined;
  const enabled = k?.enabled ?? true;
  if (!enabled) return undefined;
  return new AdaptiveRuntimeKernel({
    enabled: true,
    ollamaUrl: k?.ollama_url ?? 'http://127.0.0.1:11434',
    ollamaModel: k?.ollama_model ?? 'qwen2.5:3b',
    embedModel: k?.embed_model ?? 'nomic-embed-text',
    attentionCeiling: k?.attention_ceiling ?? 0.65,
    worktree,
    maxWindow,
    maxMounted: k?.max_mounted ?? 8,
    reselectEvery: k?.reselect_every ?? 4,
    registry: k?.registry ?? true,
    localDiscovery: k?.local_discovery ?? true,
    publicSkills: k?.public_skills ?? true,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
