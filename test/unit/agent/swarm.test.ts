import { describe, expect, it } from 'vitest';
import {
  SwarmCoordinator,
  SWARM_ROLES,
  type AuditResult,
  type ImplResult,
  type MilestoneSpec,
  type QaResult,
  type SwarmEvent,
  type SwarmExecutors,
} from '../../../src/agent/swarm.js';
import { RegionLockManager, type ActiveLock } from '../../../src/workers/file-locks.js';
import { SharedScratchpad } from '../../../src/workers/scratchpad.js';

const spec: MilestoneSpec = {
  id: 'M1',
  title: 'Add a thing',
  summary: 'One file, one region.',
  files: [{ path: 'src/thing.ts', action: 'modify', regions: [{ startLine: 1, endLine: 40 }] }],
  acceptance: ['unit tests pass'],
  dependencies: [],
};

const impl: ImplResult = { summary: 'wrote it', changedFiles: ['src/thing.ts'] };
const cleanQa: QaResult = {
  summary: 'nothing broke',
  testsWritten: ['thing.fuzz.test.ts'],
  failures: [],
};
const cleanAudit: AuditResult = { summary: 'no findings', findings: [] };

interface Harness {
  coordinator: SwarmCoordinator;
  scratchpad: SharedScratchpad;
  locks: RegionLockManager;
  order: string[];
  events: SwarmEvent[];
  locksDuringImpl: () => ActiveLock[];
}

function harness(overrides: Partial<SwarmExecutors> = {}): Harness {
  const scratchpad = new SharedScratchpad();
  const locks = new RegionLockManager();
  const order: string[] = [];
  const events: SwarmEvent[] = [];
  let duringImpl: ActiveLock[] = [];
  const executors: SwarmExecutors = {
    architect: () => {
      order.push('architect');
      return Promise.resolve(spec);
    },
    implementer: () => {
      order.push('implementer');
      duringImpl = locks.activeLocks();
      return Promise.resolve(impl);
    },
    redTeam: () => {
      order.push('red-team');
      return Promise.resolve(cleanQa);
    },
    auditor: () => {
      order.push('auditor');
      return Promise.resolve(cleanAudit);
    },
    ...overrides,
  };
  return {
    coordinator: new SwarmCoordinator({
      executors,
      scratchpad,
      locks,
      onEvent: (e) => events.push(e),
    }),
    scratchpad,
    locks,
    order,
    events,
    locksDuringImpl: () => duringImpl,
  };
}

describe('SWARM_ROLES', () => {
  it('keeps the architect and auditor read-only and scopes the writers', () => {
    expect(SWARM_ROLES.architect.capabilities).toEqual(['read']);
    expect(SWARM_ROLES.auditor.capabilities).toEqual(['read']);
    expect(SWARM_ROLES.implementer.capabilities).toContain('write-code');
    expect(SWARM_ROLES.implementer.capabilities).toContain('lock-regions');
    expect(SWARM_ROLES['red-team'].capabilities).toContain('write-tests');
    expect(SWARM_ROLES['red-team'].capabilities).not.toContain('write-code');
  });
});

describe('SwarmCoordinator.run', () => {
  it('runs the four phases in order and writes each output to the scratchpad', async () => {
    const h = harness();
    const report = await h.coordinator.run('add a thing');

    expect(h.order).toEqual(['architect', 'implementer', 'red-team', 'auditor']);
    expect(h.scratchpad.get('spec', 'M1')).toEqual(spec);
    expect(h.scratchpad.get('impl', 'M1')).toEqual(impl);
    expect(h.scratchpad.get('qa', 'M1')).toEqual(cleanQa);
    expect(h.scratchpad.get('audit', 'M1')).toEqual(cleanAudit);
    expect(report).toMatchObject({ spec, impl, qa: cleanQa, audit: cleanAudit });
    expect(h.events.map((e) => `${e.phase}:${e.stage}`)).toEqual([
      'architect:start',
      'architect:done',
      'implementer:start',
      'implementer:done',
      'red-team:start',
      'red-team:done',
      'auditor:start',
      'auditor:done',
    ]);
  });

  it('holds the spec regions during the implementer phase and releases them after', async () => {
    const h = harness();
    await h.coordinator.run('add a thing');

    const during = h.locksDuringImpl();
    expect(during).toHaveLength(1);
    expect(during[0]?.ownerId).toBe('implementer');
    expect(during[0]?.regions).toEqual([{ path: 'src/thing.ts', startLine: 1, endLine: 40 }]);
    expect(h.locks.activeLocks()).toEqual([]);
  });

  it('releases the locks when the implementer throws', async () => {
    const h = harness({
      implementer: () => Promise.reject(new Error('implementer died')),
    });
    await expect(h.coordinator.run('add a thing')).rejects.toThrow('implementer died');
    expect(h.locks.activeLocks()).toEqual([]);
  });

  it('passes when QA is clean and the audit has no blocking findings', async () => {
    const h = harness({
      auditor: () =>
        Promise.resolve({
          summary: 'one nit',
          findings: [{ severity: 'minor', rule: 'style', detail: 'nit' }],
        } satisfies AuditResult),
    });
    const report = await h.coordinator.run('add a thing');
    expect(report.verdict).toBe('pass');
  });

  it('fails when the red-team breaks the implementation', async () => {
    const h = harness({
      redTeam: () =>
        Promise.resolve({
          summary: 'broke it',
          testsWritten: ['thing.fuzz.test.ts'],
          failures: [{ test: 'fuzz: empty input', detail: 'threw TypeError' }],
        } satisfies QaResult),
    });
    const report = await h.coordinator.run('add a thing');
    expect(report.verdict).toBe('fail');
  });

  it('fails when the auditor reports a blocking finding', async () => {
    const h = harness({
      auditor: () =>
        Promise.resolve({
          summary: 'unsafe',
          findings: [
            {
              severity: 'blocking',
              rule: 'OWASP A03:2021 Injection',
              detail: 'unsanitized input reaches exec',
              path: 'src/thing.ts',
            },
          ],
        } satisfies AuditResult),
    });
    const report = await h.coordinator.run('add a thing');
    expect(report.verdict).toBe('fail');
  });
});
