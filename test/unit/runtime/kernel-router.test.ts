/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await, @typescript-eslint/no-base-to-string -- test doubles */
import { describe, expect, it } from 'vitest';
import {
  CapabilityIndex,
  LocalMetaRouter,
  heuristicAllocate,
  parseAllocationJson,
} from '../../../src/runtime/kernel/ollamaRouter.js';
import type { AllocateRequest, CapabilityEntry } from '../../../src/runtime/kernel/types.js';

const profile = { maxWindow: 100_000, attentionCeiling: 0.65, maxMountedTools: 5 };

function req(
  over: Partial<AllocateRequest> & { objective: string },
  candidates: CapabilityEntry[] = [],
): AllocateRequest {
  return {
    stateDelta: '',
    telemetry: {
      frictionScore: 0,
      contextPressure: 0,
      epistemicUncertainty: 0,
      consecutiveFailures: 0,
      lastToolSignature: '',
      turn: 1,
    },
    candidates,
    profile,
    ...over,
  };
}

describe('parseAllocationJson', () => {
  it('parses strict JSON and fenced JSON', () => {
    const raw = JSON.stringify({
      tier: 1,
      reasoningMode: 'cot',
      activeRoles: ['planner', 'executor'],
      mountedTools: ['read', 'search'],
      mountedSkills: [],
      maxTokensTurn: 2048,
      allowCodeModeBatching: true,
      blastRadius: 'low',
    });
    expect(parseAllocationJson(raw)?.tier).toBe(1);
    expect(parseAllocationJson('```json\n' + raw + '\n```')?.reasoningMode).toBe('cot');
  });

  it('rejects invalid payloads', () => {
    expect(parseAllocationJson('not json')).toBeUndefined();
    expect(parseAllocationJson('{"tier":9,"reasoningMode":"cot"}')).toBeUndefined();
  });
});

describe('heuristicAllocate', () => {
  const tools: CapabilityEntry[] = [
    {
      kind: 'tool',
      id: 'read',
      name: 'read',
      description: 'read a file',
      tokens: ['read', 'file'],
    },
    {
      kind: 'tool',
      id: 'bash',
      name: 'bash',
      description: 'run a shell command',
      tokens: ['bash', 'shell', 'command'],
    },
    {
      kind: 'skill',
      id: 'testing',
      name: 'testing',
      description: 'write tests',
      tokens: ['testing', 'write', 'tests'],
    },
  ];

  it('uses fast path for low friction', () => {
    const a = heuristicAllocate(req({ objective: 'read the README' }), tools);
    expect(a.tier).toBe(0);
    expect(a.reasoningMode).toBe('zero-shot');
    expect(a.activeRoles).toEqual(['executor']);
    expect(a.mountedTools.length).toBeGreaterThan(0);
  });

  it('escalates to MCTS on high friction', () => {
    const a = heuristicAllocate(
      req({
        objective: 'fix the flaky suite',
        telemetry: {
          frictionScore: 4,
          contextPressure: 0.2,
          epistemicUncertainty: 0.1,
          consecutiveFailures: 3,
          lastToolSignature: 'bash:npm test',
          turn: 5,
        },
      }),
      tools,
    );
    expect(a.tier).toBe(2);
    expect(a.reasoningMode).toBe('mcts');
    expect(a.mctsBranchFactor).toBe(3);
    expect(a.activeRoles).toContain('adversarial_critic');
  });

  it('requests GC compaction under pressure', () => {
    const a = heuristicAllocate(
      req({
        objective: 'continue',
        telemetry: {
          frictionScore: 0,
          contextPressure: 0.95,
          epistemicUncertainty: 0,
          consecutiveFailures: 0,
          lastToolSignature: '',
          turn: 20,
        },
      }),
      tools,
    );
    expect(a.tier).toBe(3);
    expect(a.maxTokensTurn).toBe(400);
  });
});

describe('CapabilityIndex TF-IDF fallback', () => {
  it('ranks by keyword overlap when embeddings are unavailable', async () => {
    const index = new CapabilityIndex({
      baseUrl: 'http://127.0.0.1:9', // unreachable
      chatModel: 'x',
      embedModel: 'nomic-embed-text',
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await index.index(
      [
        { name: 'read', description: 'read file contents from disk' },
        { name: 'bash', description: 'execute shell commands' },
        { name: 'search', description: 'search code with regex' },
      ],
      [
        {
          name: 'testing',
          description: 'author unit tests',
          triggerConditions: 'when writing tests',
        },
      ],
    );
    expect(index.usingEmbeddings).toBe(false);
    const hits = index.tfidfSearch('search the codebase with regex', 2);
    expect(hits[0]?.id).toBe('search');
  });
});

describe('LocalMetaRouter', () => {
  it('falls back to heuristics when Ollama is unreachable', async () => {
    const index = new CapabilityIndex({
      baseUrl: 'http://127.0.0.1:9',
      chatModel: 'qwen2.5:3b',
      embedModel: 'nomic-embed-text',
      timeoutMs: 50,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    await index.index([{ name: 'read', description: 'read files' }], []);
    const router = new LocalMetaRouter({
      baseUrl: 'http://127.0.0.1:9',
      chatModel: 'qwen2.5:3b',
      embedModel: 'nomic-embed-text',
      timeoutMs: 50,
      index,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    const alloc = await router.allocate(req({ objective: 'read src/main.ts' }));
    expect(alloc.tier).toBeDefined();
    expect(alloc.mountedTools).toContain('read');
  });

  it('accepts a valid SLM JSON response', async () => {
    const payload = {
      tier: 1,
      reasoningMode: 'reflexion',
      activeRoles: ['executor', 'verifier'],
      mountedTools: ['read', 'bash'],
      mountedSkills: [],
      maxTokensTurn: 1800,
      allowCodeModeBatching: false,
      blastRadius: 'medium',
    };
    const index = new CapabilityIndex({
      baseUrl: 'http://ollama.test',
      chatModel: 'qwen2.5:3b',
      embedModel: 'nomic-embed-text',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ embedding: [0.1, 0.2] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await index.index(
      [
        { name: 'read', description: 'read' },
        { name: 'bash', description: 'bash' },
      ],
      [],
    );
    const router = new LocalMetaRouter({
      baseUrl: 'http://ollama.test',
      chatModel: 'qwen2.5:3b',
      embedModel: 'nomic-embed-text',
      index,
      fetchImpl: (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/api/chat')) {
          return new Response(JSON.stringify({ message: { content: JSON.stringify(payload) } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const alloc = await router.allocate(
      req({
        objective: 'run tests',
        candidates: [
          { kind: 'tool', id: 'read', name: 'read', description: 'read', tokens: ['read'] },
          { kind: 'tool', id: 'bash', name: 'bash', description: 'bash', tokens: ['bash'] },
        ],
      }),
    );
    expect(alloc.reasoningMode).toBe('reflexion');
    expect(alloc.mountedTools).toEqual(['read', 'bash']);
  });
});
