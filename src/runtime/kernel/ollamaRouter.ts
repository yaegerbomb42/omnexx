import {
  ALLOCATION_JSON_SCHEMA,
  turnAllocationSchema,
  type AllocateRequest,
  type CapabilityEntry,
  type TurnAllocation,
} from './types.js';

export interface OllamaClientOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  fetchImpl?: typeof fetch | undefined;
  /** Request timeout in ms (default 150 — fail fast when Ollama is absent). */
  timeoutMs?: number | undefined;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_+/.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** In-memory capability index with Ollama embeddings and BM25/TF-IDF fallback. */
export class CapabilityIndex {
  private entries: CapabilityEntry[] = [];
  private idf = new Map<string, number>();
  private embedReady = false;
  private ollamaUp: boolean | undefined;
  private readonly opts: Required<Pick<OllamaClientOptions, 'baseUrl' | 'embedModel'>> & {
    fetchImpl: typeof fetch;
    timeoutMs: number;
  };

  constructor(options: OllamaClientOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      embedModel: options.embedModel,
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 150,
    };
  }

  get size(): number {
    return this.entries.length;
  }

  get usingEmbeddings(): boolean {
    return this.embedReady;
  }

  get ollamaAvailable(): boolean {
    return this.ollamaUp === true;
  }

  markOffline(): void {
    this.ollamaUp = false;
    this.embedReady = false;
  }

  async probe(): Promise<boolean> {
    if (this.ollamaUp !== undefined) return this.ollamaUp;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        ctrl.abort();
      },
      Math.min(80, this.opts.timeoutMs),
    );
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/api/tags`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      this.ollamaUp = res.ok;
    } catch {
      this.ollamaUp = false;
    } finally {
      clearTimeout(timer);
    }
    return this.ollamaUp === true;
  }

  async index(
    tools: readonly { name: string; description: string }[],
    skills: readonly { name: string; description: string; triggerConditions?: string }[],
  ): Promise<void> {
    const next: CapabilityEntry[] = [];
    for (const t of tools) {
      const text = `${t.name} ${t.description}`;
      next.push({
        kind: 'tool',
        id: t.name,
        name: t.name,
        description: t.description,
        tokens: tokenize(text),
      });
    }
    for (const s of skills) {
      const text = `${s.name} ${s.description} ${s.triggerConditions ?? ''}`;
      const entry: CapabilityEntry = {
        kind: 'skill',
        id: s.name,
        name: s.name,
        description: s.description,
        tokens: tokenize(text),
      };
      if (s.triggerConditions !== undefined) entry.triggerConditions = s.triggerConditions;
      next.push(entry);
    }

    this.rebuildIdf(next);
    this.embedReady = false;
    if (await this.probe()) {
      try {
        for (const e of next.slice(0, 24)) {
          const emb = await this.embed(`${e.name}\n${e.description}\n${e.triggerConditions ?? ''}`);
          if (emb) e.embedding = emb;
          else {
            this.ollamaUp = false;
            break;
          }
        }
        this.embedReady = next.some((e) => (e.embedding?.length ?? 0) > 0);
      } catch {
        this.ollamaUp = false;
        this.embedReady = false;
      }
    }
    this.entries = next;
  }

  async search(query: string, k = 10): Promise<CapabilityEntry[]> {
    if (this.entries.length === 0) return [];
    if (this.embedReady) {
      const q = await this.embed(query).catch(() => undefined);
      if (q && q.length > 0) {
        return [...this.entries]
          .map((e) => ({ e, score: e.embedding ? cosine(q, e.embedding) : 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k)
          .map((x) => x.e);
      }
    }
    return this.tfidfSearch(query, k);
  }

  tfidfSearch(query: string, k = 10): CapabilityEntry[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return this.entries.slice(0, k);
    const qtf = termFreq(qTokens);
    return [...this.entries]
      .map((e) => ({ e, score: tfidfScore(qtf, e.tokens, this.idf) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.e);
  }

  private rebuildIdf(entries: CapabilityEntry[]): void {
    const df = new Map<string, number>();
    for (const e of entries) {
      for (const t of new Set(e.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const N = Math.max(1, entries.length);
    this.idf = new Map([...df.entries()].map(([t, d]) => [t, Math.log((N + 1) / (d + 1)) + 1]));
  }

  private async embed(text: string): Promise<number[] | undefined> {
    if (this.ollamaUp === false) return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.opts.timeoutMs);
    try {
      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.opts.embedModel, prompt: text }),
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { embedding?: number[] };
      return Array.isArray(body.embedding) ? body.embedding : undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function tfidfScore(
  qtf: Map<string, number>,
  docTokens: string[],
  idf: Map<string, number>,
): number {
  const dtf = termFreq(docTokens);
  let score = 0;
  for (const [t, qf] of qtf) {
    const df = dtf.get(t);
    if (!df) continue;
    score += qf * df * (idf.get(t) ?? 1);
  }
  return score;
}

export interface LocalMetaRouterOptions extends OllamaClientOptions {
  index: CapabilityIndex;
}

export class LocalMetaRouter {
  private readonly opts: {
    baseUrl: string;
    chatModel: string;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  };
  private readonly index: CapabilityIndex;

  constructor(options: LocalMetaRouterOptions) {
    this.index = options.index;
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/$/, ''),
      chatModel: options.chatModel,
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 150,
    };
  }

  async allocate(req: AllocateRequest): Promise<TurnAllocation> {
    const top = req.candidates.length
      ? req.candidates
      : await this.index.search(`${req.objective}\n${req.stateDelta}`, 10);
    if (this.index.ollamaAvailable || (await this.index.probe())) {
      try {
        const fromSlm = await this.askSlm(req, top);
        if (fromSlm) return clampAllocation(fromSlm, req, top);
      } catch {
        this.index.markOffline();
      }
    }
    return heuristicAllocate(req, top);
  }

  private async askSlm(
    req: AllocateRequest,
    top: readonly CapabilityEntry[],
  ): Promise<TurnAllocation | undefined> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
    }, this.opts.timeoutMs);
    try {
      const toolNames = top.filter((c) => c.kind === 'tool').map((c) => c.id);
      const skillNames = top.filter((c) => c.kind === 'skill').map((c) => c.id);
      const prompt = [
        'Allocate the next agent turn. Reply with JSON only.',
        `objective: ${req.objective.slice(0, 400)}`,
        `state_delta: ${req.stateDelta.slice(0, 200)}`,
        `friction: ${req.telemetry.frictionScore.toFixed(2)}`,
        `pressure: ${req.telemetry.contextPressure.toFixed(2)}`,
        `uncertainty: ${req.telemetry.epistemicUncertainty.toFixed(2)}`,
        `candidate_tools: ${toolNames.join(',') || '(none)'}`,
        `candidate_skills: ${skillNames.join(',') || '(none)'}`,
        `max_tools: ${req.profile.maxMountedTools}`,
      ].join('\n');

      const res = await this.opts.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.chatModel,
          stream: false,
          keep_alive: -1,
          format: ALLOCATION_JSON_SCHEMA,
          options: { temperature: 0 },
          messages: [
            {
              role: 'system',
              content:
                'You are the Omnexx kernel meta-router. Output a compact TurnAllocation JSON under 50 tokens of content.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { message?: { content?: string } };
      const raw = body.message?.content?.trim();
      if (!raw) return undefined;
      return parseAllocationJson(raw);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseAllocationJson(raw: string): TurnAllocation | undefined {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  const result = turnAllocationSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function heuristicAllocate(
  req: AllocateRequest,
  top: readonly CapabilityEntry[],
): TurnAllocation {
  const { frictionScore: F, contextPressure: P, epistemicUncertainty: U } = req.telemetry;
  let tier: TurnAllocation['tier'] = 0;
  let reasoningMode: TurnAllocation['reasoningMode'] = 'zero-shot';
  if (P >= 0.9) {
    tier = 3;
    reasoningMode = 'cot';
  } else if (F >= 3 || U >= 0.7) {
    tier = 2;
    reasoningMode = 'mcts';
  } else if (F >= 1.5 || U >= 0.75) {
    tier = 1;
    reasoningMode = 'reflexion';
  } else if (/plan|design|architect|refactor/i.test(req.objective)) {
    tier = 1;
    reasoningMode = 'cot';
  }

  const roles: TurnAllocation['activeRoles'] =
    tier >= 2
      ? ['planner', 'executor', 'verifier', 'adversarial_critic']
      : tier === 1
        ? ['planner', 'executor', 'verifier']
        : ['executor'];

  const maxTools = Math.min(req.profile.maxMountedTools, tier >= 2 ? 15 : 5);
  const mountedTools = top
    .filter((c) => c.kind === 'tool')
    .slice(0, maxTools)
    .map((c) => c.id);
  const mountedSkills = top
    .filter((c) => c.kind === 'skill')
    .slice(0, 3)
    .map((c) => c.id);

  const maxTokensTurn =
    tier === 3 ? 400 : tier === 0 ? 1_024 : reasoningMode === 'mcts' ? 4_096 : 2_048;

  const blastRadius: TurnAllocation['blastRadius'] =
    F >= 3 || /rm\s|migrate|production|deploy/i.test(req.objective)
      ? 'high'
      : /edit|write|bash|refactor/i.test(req.objective)
        ? 'medium'
        : 'low';

  const out: TurnAllocation = {
    tier,
    reasoningMode,
    activeRoles: roles,
    mountedTools,
    mountedSkills,
    maxTokensTurn,
    allowCodeModeBatching: tier <= 1 && P < 0.7,
    blastRadius,
  };
  if (reasoningMode === 'mcts') out.mctsBranchFactor = 3;
  return out;
}

function clampAllocation(
  alloc: TurnAllocation,
  req: AllocateRequest,
  top: readonly CapabilityEntry[],
): TurnAllocation {
  const allowedTools = new Set(top.filter((c) => c.kind === 'tool').map((c) => c.id));
  const allowedSkills = new Set(top.filter((c) => c.kind === 'skill').map((c) => c.id));
  const maxTools = req.profile.maxMountedTools;
  const mountedTools = alloc.mountedTools
    .filter((t) => allowedTools.size === 0 || allowedTools.has(t))
    .slice(0, maxTools);
  const mountedSkills = alloc.mountedSkills
    .filter((s) => allowedSkills.size === 0 || allowedSkills.has(s))
    .slice(0, 8);
  const tools =
    mountedTools.length > 0
      ? mountedTools
      : top
          .filter((c) => c.kind === 'tool')
          .slice(0, maxTools)
          .map((c) => c.id);
  return { ...alloc, mountedTools: tools, mountedSkills };
}

export function multiSampleAllocations(
  req: AllocateRequest,
  top: readonly CapabilityEntry[],
  samples = 3,
): TurnAllocation[] {
  const out: TurnAllocation[] = [];
  for (let i = 0; i < samples; i++) {
    const friction = Math.max(0, req.telemetry.frictionScore + (i - 1) * 0.75);
    const pressure = Math.min(2, Math.max(0, req.telemetry.contextPressure + (i - 1) * 0.05));
    const uncertainty = Math.min(
      1,
      Math.max(0, req.telemetry.epistemicUncertainty + (i - 1) * 0.1),
    );
    const rotated = [...top.slice(i), ...top.slice(0, i)];
    out.push(
      heuristicAllocate(
        {
          ...req,
          telemetry: {
            ...req.telemetry,
            frictionScore: friction,
            contextPressure: pressure,
            epistemicUncertainty: uncertainty,
          },
          candidates: rotated,
        },
        rotated,
      ),
    );
  }
  return out;
}

export function allocationSimilarities(samples: readonly TurnAllocation[]): number[] {
  const sims: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = new Set(samples[i]!.mountedTools);
      const b = new Set(samples[j]!.mountedTools);
      if (a.size === 0 && b.size === 0) {
        sims.push(samples[i]!.reasoningMode === samples[j]!.reasoningMode ? 1 : 0);
        continue;
      }
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const union = a.size + b.size - inter;
      sims.push(union === 0 ? 0 : inter / union);
    }
  }
  return sims;
}
