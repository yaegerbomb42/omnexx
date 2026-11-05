import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CapabilityBandit,
  PhaseMachine,
  classifyTask,
  decideCadence,
  isRealVerification,
  lexicalDrift,
} from '../../../src/runtime/kernel/optimizer.js';
import { CapabilityCatalog, createCatalogTools } from '../../../src/runtime/kernel/catalog.js';
import type { ToolContext } from '../../../src/tools/types.js';

const base = {
  newTask: false,
  phaseShift: false,
  drift: 0,
  toolMiss: false,
  frictionScore: 0,
  agentRequested: false,
  prefixTokens: 40_000,
  directiveTokens: 600,
  expectedRemainingTurns: 10,
  needsVerify: false,
  gcFreeTokens: 0,
  taskClass: 'standard' as const,
};

describe('GeneralAgentOptimizer pieces', () => {
  it('classifies tasks in well under 50ms', () => {
    expect(classifyTask('what does this function return?').taskClass).toBe('trivial');
    expect(classifyTask('add a --json flag to the status command and test it').taskClass).toBe(
      'standard',
    );
    expect(classifyTask('refactor the auth module to fix the race condition').taskClass).toBe(
      'deliberative',
    );
    expect(classifyTask('create a github issue for the sentry crash').intent).toBe('bugfix');
    expect(classifyTask('x'.repeat(50)).ms).toBeLessThan(50);
  });

  it('never treats echo/ls as verification', () => {
    expect(isRealVerification('bash', { command: 'echo ok' })).toBe(false);
    expect(isRealVerification('bash', { command: 'ls -la && cat x' })).toBe(false);
    expect(isRealVerification('bash', { command: 'npx vitest run test/a.test.ts' })).toBe(true);
    expect(isRealVerification('bash', { command: 'cd pkg && npm test' })).toBe(true);
    expect(isRealVerification('read', { path: 'x' })).toBe(false);
  });

  it('walks orient -> plan -> act -> verify -> synthesize', () => {
    const m = new PhaseMachine(classifyTask('add a --json flag to the status command'));
    for (const t of ['read', 'search', 'read']) m.observe({ tool: t, input: {}, isError: false });
    expect(m.phase).toBe('plan');
    m.observe({ tool: 'edit', input: {}, isError: false });
    expect(m.phase).toBe('act');
    expect(m.tick(false)).toBe('verify');
    m.observe({ tool: 'bash', input: { command: 'echo done' }, isError: false });
    expect(m.phase).toBe('verify');
    m.observe({ tool: 'bash', input: { command: 'npm test' }, isError: false });
    expect(m.phase).toBe('synthesize');
    expect(m.isVerified).toBe(true);
  });

  it('cadence stays sticky on progress and reselects append-only on a miss', () => {
    expect(decideCadence(base).action).toBe('stay_sticky');
    const miss = decideCadence({ ...base, toolMiss: true });
    expect(miss.action).toBe('reselect_append_only');
    expect(miss.reason).toBe('tool_miss');
    const start = decideCadence({ ...base, newTask: true, prefixTokens: 2_000 });
    expect(start.reason).toBe('task_start');
    expect(decideCadence({ ...base, needsVerify: true }).action).toBe('verify_now');
    expect(lexicalDrift('fix the jira sync', 'fix the jira sync')).toBe(0);
  });

  it('discounted UCB bandit learns, decays and persists (no-op when unwritable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bandit-'));
    const path = join(dir, '.omnexx', 'kernel-bandit.json');
    const b = new CapabilityBandit(path);
    for (let i = 0; i < 5; i++) b.update('bugfix', 'mcp:sentry', { progress: 1 });
    b.update('bugfix', 'mcp:jira', { progress: 0 });
    expect(b.bonus('bugfix', 'mcp:sentry')).toBeGreaterThan(b.bonus('bugfix', 'mcp:jira'));
    b.decay('bugfix');
    b.save();
    expect(JSON.parse(readFileSync(path, 'utf8')).arms['bugfix|mcp:sentry'].pulls).toBeCloseTo(
      4.85,
    );
    expect(new CapabilityBandit(path).top(1)[0]?.arm).toBe('bugfix|mcp:sentry');
    expect(() => {
      const ro = new CapabilityBandit(join(path, 'not-a-dir', 'kernel-bandit.json'));
      ro.update('a', 'b', { progress: 1 });
      ro.save();
    }).not.toThrow();
  });

  it('manage_capabilities batches search + mount + list in one call', async () => {
    const c = new CapabilityCatalog();
    c.upsert([
      {
        id: 'local:mcp:github',
        kind: 'mcp',
        name: 'github',
        description: 'GitHub issues and pull requests',
        server: 'github',
      },
      { id: 'local:skill:release', kind: 'skill', name: 'release', description: 'cut a release' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `local:tool:f${String(i)}`,
        kind: 'tool' as const,
        name: `filler${String(i)}`,
        description: 'unrelated filler tool',
      })),
    ]);
    const [manage] = createCatalogTools(c);
    expect(manage?.name).toBe('manage_capabilities');
    const input = manage!.normalize!({
      actions: [
        { action: 'search', query: 'github pull requests', kind: 'mcp', limit: 3 },
        { action: 'mount', ids: ['local:mcp:github'] },
        { action: 'list' },
      ],
    });
    const r = await manage!.run(manage!.schema.parse(input), {} as ToolContext);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('local:mcp:github');
    expect(r.content).toMatch(/#3 list: local:mcp:github/);
    // Single action object is accepted too.
    const single = manage!.schema.parse(
      manage!.normalize!({ action: 'unmount', ids: ['local:mcp:github'] }),
    );
    expect((await manage!.run(single, {} as ToolContext)).content).toContain('unmounted');
  });
});
