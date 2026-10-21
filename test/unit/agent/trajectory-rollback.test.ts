import { describe, it, expect } from 'vitest';
import { ExecutionCallStack } from '../../../src/agent/call-stack.js';
import { EpistemicStateReducer } from '../../../src/agent/provenance.ts';

describe('Deterministic Trajectory & Epistemic Rollback', () => {
  it('unwinds call stack frames to an uncorrupted ancestor on Trap', () => {
    const stack = new ExecutionCallStack();

    stack.push({
      id: 'frame-0',
      taskId: 'M1.T01',
      title: 'Root task frame',
      assumptions: ['Database is SQLite'],
      dependencies: [],
      pushedAtCycle: 1,
      pushedAtTurn: 1,
      gitCommitSha: 'commit-root',
      status: 'active',
    });

    stack.push({
      id: 'frame-1',
      taskId: 'M1.T01.sub1',
      title: 'Sub-task assuming PostgreSQL',
      assumptions: ['Postgres pgvector extension installed'],
      dependencies: ['pg'],
      pushedAtCycle: 1,
      pushedAtTurn: 3,
      status: 'active',
    });

    // Trap is raised in sub-task
    const trapped = stack.raiseTrap('ASSUMPTION_INVALID', 'pgvector not supported in local SQLite env', 5);
    expect(trapped?.status).toBe('trapped');
    expect(trapped?.trap?.kind).toBe('ASSUMPTION_INVALID');

    // Unwind call stack to root frame
    const unwound = stack.unwindTo('frame-0');
    expect(unwound).toHaveLength(1);
    expect(unwound[0]?.id).toBe('frame-1');
    expect(stack.current()?.id).toBe('frame-0');
  });

  it('rolls back epistemic state patches to before the assumption failure turn', () => {
    const reducer = new EpistemicStateReducer();

    reducer.apply({
      id: 'patch-1',
      sourceTurnId: 1,
      cycle: 1,
      timestamp: 1000,
      ops: [
        { op: 'APPEND_FACT', fact: 'Target is TypeScript Node 22', category: 'env' },
        { op: 'RECORD_DECISION', key: 'database', value: 'sqlite' },
      ],
    });

    reducer.apply({
      id: 'patch-2',
      sourceTurnId: 3,
      cycle: 1,
      timestamp: 2000,
      ops: [
        { op: 'APPEND_FACT', fact: 'Assuming pgvector available for vector search', category: 'architecture' },
        { op: 'RECORD_DECISION', key: 'vector_store', value: 'pgvector' },
      ],
    });

    reducer.apply({
      id: 'patch-3',
      sourceTurnId: 4,
      cycle: 1,
      timestamp: 3000,
      ops: [
        { op: 'MARK_PATH_INVALID', path: 'src/db/sqlite.ts', reason: 'replaced with postgres' },
      ],
    });

    expect(reducer.getActiveFacts()).toHaveLength(2);
    expect(reducer.getDecisions().get('vector_store')?.value).toBe('pgvector');
    expect(reducer.getInvalidPaths().has('src/db/sqlite.ts')).toBe(true);

    // Rollback to before turn 3 (where the invalid assumption started)
    const discarded = reducer.rollbackTo(1, 3);
    expect(discarded).toHaveLength(2);
    expect(discarded.map((d) => d.id)).toEqual(['patch-2', 'patch-3']);

    // State is cleanly restored without hallucinatory facts or revoked paths
    const activeFacts = reducer.getActiveFacts();
    expect(activeFacts).toHaveLength(1);
    expect(activeFacts[0]?.fact).toBe('Target is TypeScript Node 22');
    expect(reducer.getDecisions().get('database')?.value).toBe('sqlite');
    expect(reducer.getDecisions().has('vector_store')).toBe(false);
    expect(reducer.getInvalidPaths().has('src/db/sqlite.ts')).toBe(false);
  });
});
