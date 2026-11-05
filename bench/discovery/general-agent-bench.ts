/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * 4-policy general-agent benchmark (npm run bench:optimizer).
 *
 * Replays 5 trajectory archetypes against the REAL catalog (full MCP Registry snapshot +
 * simulated local env from tasks.json) and the REAL wire format (turnRequest +
 * AnthropicProvider.buildParams) through a prefix-cache simulator, under four policies:
 *   A static-all     every installed capability + top registry hits mounted, fixed
 *   B naive-reselect re-rank + re-mount every turn, tools rebuilt each turn (busts Slot 0)
 *   C fixed-per-task select once at task start; misses mount via the meta-tool (tool list changes)
 *   D kernel         classifier + phases + VoI cadence + bandit priors + cache epochs
 *                    (extras append-only via directive + call_capability)
 * Reports capability recall, raw prompt tokens, billed token-equivalents (0.1x read, 1.25x
 * write), prefix-cache hit %, routing latency and turns-to-verified-completion.
 *
 * Modeled (not measured): a turn whose needed capability is not mounted costs one extra
 * discovery turn; a policy without a verify gate finishing a mutating task unverified costs
 * a 2-turn re-entry when the cycle verifier rejects it (D pays 1 nudged verification turn).
 */
import { z } from 'zod';
import { turnRequest } from '../../src/agent/context.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import type { Message, SystemBlock, ToolSpec } from '../../src/providers/types.js';
import {
  ToolEpoch,
  capabilityDirective,
  estimateTokens,
} from '../../src/runtime/kernel/cache-epoch.js';
import type { CatalogEntry } from '../../src/runtime/kernel/catalog.js';
import {
  GeneralAgentOptimizer,
  decideCadence,
  lexicalDrift,
} from '../../src/runtime/kernel/optimizer.js';
import { toolSpec } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/types.js';
import { buildCatalog, relevant } from './eval.js';
import { PrefixCache } from './prefix-cache.js';

interface Step {
  tool: string;
  input?: Record<string, unknown>;
  error?: string;
  /** Capability groups (keyword lists) this step needs mounted. */
  needs?: string[][];
  /** New user instruction arriving this turn (pivot). */
  say?: string;
}
interface Archetype {
  name: string;
  objective: string;
  steps: Step[];
}

const A: Archetype[] = [
  {
    name: 'trivial Q&A',
    objective: 'what does the retry helper in src/providers/retry.ts do?',
    steps: [{ tool: 'read' }, { tool: 'answer' }],
  },
  {
    name: 'multi-step repo feature',
    objective: 'add a --json flag to the omnexx status command, test it and document it',
    steps: [
      { tool: 'search' },
      { tool: 'read' },
      { tool: 'read' },
      { tool: 'edit' },
      { tool: 'edit' },
      { tool: 'bash', input: { command: 'npx vitest run test/unit/cli' } },
      { tool: 'edit' },
      { tool: 'answer' },
    ],
  },
  {
    name: 'external MCP workflow',
    objective:
      'triage the latest Sentry crash, open a GitHub issue with the stack trace and post it to Slack',
    steps: [
      { tool: 'mcp__sentry__list_issues', needs: [['sentry']] },
      { tool: 'mcp__sentry__get_event', needs: [['sentry']] },
      { tool: 'read' },
      { tool: 'mcp__github__create_issue', needs: [['github']] },
      { tool: 'mcp__github__add_labels', needs: [['github']] },
      { tool: 'mcp__slack__post_message', needs: [['slack']] },
      { tool: 'answer' },
    ],
  },
  {
    name: 'high-friction bugfix',
    objective: 'fix the flaky postgres migration test that times out in CI',
    steps: [
      { tool: 'read' },
      { tool: 'mcp__postgres__query', needs: [['postgres']] },
      {
        tool: 'bash',
        input: { command: 'npm test -- migration' },
        error: 'ECONNREFUSED 5432 postgres connection refused',
      },
      {
        tool: 'mcp__postgres__query',
        needs: [['postgres']],
        error: 'relation "schema_migrations" is locked',
      },
      { tool: 'edit' },
      { tool: 'bash', input: { command: 'npm test -- migration' }, error: 'timeout after 5000ms' },
      { tool: 'edit' },
      { tool: 'bash', input: { command: 'npm test -- migration' } },
      { tool: 'answer' },
    ],
  },
  {
    name: 'mid-task pivot',
    objective: 'draft release notes for v0.23 from the git history',
    steps: [
      { tool: 'bash', input: { command: 'git log --oneline v0.22..HEAD' } },
      { tool: 'read', needs: [['release-notes']] },
      { tool: 'edit', needs: [['release-notes']] },
      {
        tool: 'mcp__linear__create_issue',
        say: 'actually, open a Linear ticket for the login regression and check the users table in the database',
        needs: [['linear']],
      },
      { tool: 'mcp__postgres__query', needs: [['postgres']] },
      { tool: 'mcp__linear__update_issue', needs: [['linear']] },
      { tool: 'answer' },
    ],
  },
];

type Policy = 'A static-all' | 'B naive-reselect' | 'C fixed-per-task' | 'D kernel';
const POLICIES: Policy[] = ['A static-all', 'B naive-reselect', 'C fixed-per-task', 'D kernel'];

const pad = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1)));
const fakeTool = (name: string, desc: string): Tool => ({
  name,
  description: desc.slice(0, 400),
  schema: z.object({ a: z.string(), b: z.number().optional() }),
  readOnly: true,
  run: () => Promise.resolve({ content: 'ok' }),
});
const CORE = [
  'read',
  'edit',
  'bash',
  'search',
  'write',
  'outline',
  'todo',
  'manage_capabilities',
].map((n) => fakeTool(n, `${n}: ${pad(500, 'core tool behaviour and arguments')}`));
/** A mounted MCP server / skill exposes tools (5 per server, 1 per skill) in Slot 0. */
function toolsFor(e: CatalogEntry): Tool[] {
  if (e.kind === 'tool') return [];
  const n = e.kind === 'mcp' ? 5 : 1;
  const key =
    (e.server ?? e.name)
      .split('/')
      .pop()
      ?.replace(/[^a-z0-9]/gi, '_') ?? 'x';
  return Array.from({ length: n }, (_, i) =>
    fakeTool(`mcp__${key}__op${String(i)}`, `${e.description} ${pad(300, 'parameters')}`),
  );
}
const system: SystemBlock[] = [
  { text: pad(6000, 'system rules'), cacheBreakpoint: true },
  { text: pad(1500, 'project notes'), cacheBreakpoint: true },
];
const provider = new AnthropicProvider({ apiKey: 'sim', cacheTtl: '5m', timeoutMs: 1 });

const { catalog } = buildCatalog();
const installed = catalog.allEntries().filter((e) => e.id.startsWith('local:'));

function covered(
  mounted: readonly CatalogEntry[],
  needs: string[][] | undefined,
): [number, number] {
  if (!needs?.length) return [0, 0];
  return [needs.filter((g) => mounted.some((e) => relevant(e, g))).length, needs.length];
}

function run(policy: Policy, arch: Archetype) {
  const cache = new PrefixCache();
  const epoch = new ToolEpoch();
  const opt = new GeneralAgentOptimizer();
  opt.startTask(arch.objective);
  for (const id of catalog.getMountedIds()) catalog.unmount(id);
  let objective = arch.objective;
  let messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: `${pad(2500, 'task frame')}\n${objective}` }] },
  ];
  let mounted: CatalogEntry[] = [];
  let lastErr = '';
  let lastQuery = '';
  const stats = {
    hit: 0,
    need: 0,
    raw: 0,
    billed: 0,
    read: 0,
    routeMs: 0,
    routes: 0,
    turns: 0,
    extraTurns: 0,
  };
  const select = (q: string, max: number, ctx?: string): CatalogEntry[] => {
    const t0 = performance.now();
    const r = catalog.select({ query: q, maxMounted: max, ...(ctx ? { context: ctx } : {}) });
    stats.routeMs += performance.now() - t0;
    stats.routes += 1;
    lastQuery = q;
    return r.mounted.slice();
  };
  if (policy === 'A static-all') {
    mounted = [
      ...installed.filter((e) => e.kind !== 'tool'),
      ...select(objective, 6).filter((e) => !e.id.startsWith('local:')),
    ];
  } else if (policy === 'C fixed-per-task') mounted = select(objective, 6);
  let mutated = false;
  let verified = false;
  for (let t = 0; t < arch.steps.length; t++) {
    const step = arch.steps[t]!;
    if (step.say) {
      objective = `${objective}\n${step.say}`;
      messages = [...messages, { role: 'user', content: [{ type: 'text', text: step.say }] }];
      if (policy === 'D kernel') opt.startTask(step.say);
    }
    const q = `${objective}\n${lastErr}`;
    let directive = '';
    let tools: ToolSpec[];
    if (policy === 'B naive-reselect') mounted = select(q, 6, lastErr || undefined);
    if (policy === 'D kernel') {
      const { phase, shifted } = opt.beginTurn();
      const cad = decideCadence({
        newTask: t === 0 || Boolean(step.say),
        phaseShift: shifted && (phase === 'act' || phase === 'verify'),
        drift: lastQuery ? lexicalDrift(q, lastQuery) : 1,
        toolMiss: Boolean(lastErr),
        frictionScore: lastErr ? 2 : 0,
        agentRequested: false,
        prefixTokens: estimateTokens(messages),
        directiveTokens: 600,
        expectedRemainingTurns: arch.steps.length - t,
        needsVerify: phase === 'verify' && opt.phases.needsVerify,
        gcFreeTokens: 0,
        taskClass: opt.profile.taskClass,
      });
      if (cad.action === 'reselect_append_only' || cad.action === 'rebake_epoch')
        mounted = select(q, Math.min(6, opt.profile.topK), lastErr || undefined);
      if (phase === 'verify')
        directive = '[kernel:phase verify] run the real checks before finishing.';
    }
    // Discovery miss: the agent spends a turn on the meta-tool, then the capability mounts.
    const [h, n] = covered(mounted, step.needs);
    if (n && h < n) {
      stats.extraTurns += 1;
      const extra = select(step.needs!.flat().join(' '), 3);
      mounted = [...mounted, ...extra.filter((e) => step.needs!.some((g) => relevant(e, g)))];
    }
    stats.hit += h;
    stats.need += n;
    const mountedTools = [...CORE, ...mounted.flatMap(toolsFor)];
    if (policy === 'D kernel') {
      const p = epoch.plan({
        mounted: mountedTools,
        suffixTokens: estimateTokens(system) + estimateTokens(messages),
        foldBustTokens: estimateTokens(system) + estimateTokens(messages.slice(0, 1)),
        expectedRemainingTurns: arch.steps.length - t,
      });
      tools = p.specs;
      directive = [capabilityDirective(p.extra), directive].filter(Boolean).join('\n\n');
    } else tools = mountedTools.map(toolSpec);
    const params = provider.buildParams(
      turnRequest(
        { system, tools },
        messages,
        'sim',
        100,
        undefined,
        directive ? { terminalDirective: directive } : undefined,
      ),
    );
    const b = cache.bill(params);
    stats.raw += b.total;
    stats.billed += b.billed;
    stats.read += b.read;
    stats.turns += 1;
    lastErr = step.error ? `${step.tool}: ${step.error}` : '';
    if (
      /^(edit|write)$/.test(step.tool) ||
      (step.tool.startsWith('mcp__') && /create|update|post|add/.test(step.tool))
    )
      mutated = true;
    if (step.tool === 'bash' && !step.error && /test|vitest/.test(String(step.input?.command)))
      verified = true;
    if (policy === 'D kernel')
      opt.observeTool({
        tool: step.tool,
        input: step.input ?? {},
        isError: Boolean(step.error),
        usedCapabilities: [],
        progress: step.error ? 0 : 1,
      });
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `t${String(t)}`, name: step.tool, input: step.input ?? {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: `t${String(t)}`,
            content: step.error ?? pad(1200, `output ${String(t)}`),
          },
        ],
      },
    ] as Message[];
  }
  // Verify gate: D spends one nudged verification turn; the others finish unverified and
  // pay a 2-turn re-entry when the cycle verifier rejects the work.
  const unverifiedPenalty = mutated && !verified ? (policy === 'D kernel' ? 1 : 2) : 0;
  return { ...stats, turnsToVerified: stats.turns + stats.extraTurns + unverifiedPenalty };
}

const rows: Record<Policy, ReturnType<typeof run>[]> = {
  'A static-all': [],
  'B naive-reselect': [],
  'C fixed-per-task': [],
  'D kernel': [],
};
for (const p of POLICIES) for (const a of A) rows[p].push(run(p, a));

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
console.log(
  `policy               recall  raw-prompt  billed(tok-eq)  cache-hit  route-ms/turn  turns-to-verified`,
);
for (const p of POLICIES) {
  const r = rows[p];
  const recall = sum(r.map((x) => x.hit)) / Math.max(1, sum(r.map((x) => x.need)));
  const raw = sum(r.map((x) => x.raw));
  const billed = sum(r.map((x) => x.billed));
  const hit = sum(r.map((x) => x.read)) / raw;
  const ms = sum(r.map((x) => x.routeMs)) / sum(r.map((x) => x.turns));
  const turns = sum(r.map((x) => x.turnsToVerified));
  console.log(
    `${p.padEnd(20)} ${recall.toFixed(3).padStart(6)}  ${String(raw).padStart(10)}  ${String(Math.round(billed)).padStart(14)}  ${(hit * 100).toFixed(1).padStart(8)}%  ${ms.toFixed(2).padStart(13)}  ${String(turns).padStart(17)}`,
  );
}
if (process.argv.includes('--per-archetype'))
  for (const p of POLICIES)
    for (const [i, x] of rows[p].entries())
      console.log(
        `  ${p.padEnd(18)} ${A[i]!.name.padEnd(24)} billed ${String(Math.round(x.billed)).padStart(8)}  hit ${((100 * x.read) / x.raw).toFixed(1)}%  recall ${x.need ? (x.hit / x.need).toFixed(2) : '  - '}  turns ${String(x.turnsToVerified)}`,
      );
