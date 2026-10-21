import { describe, expect, it } from 'vitest';
import { EpistemicStateReducer } from '../../../src/agent/provenance.js';

describe('EpistemicStateReducer', () => {
  it('applies append and revoke operations with provenance tracking', () => {
    const reducer = new EpistemicStateReducer();

    reducer.apply({
      id: 'p1',
      sourceTurnId: 2,
      cycle: 1,
      timestamp: Date.now(),
      author: 'agent',
      ops: [
        { op: 'APPEND_FACT', fact: 'Project uses vitest 5.0.3', category: 'test' },
        {
          op: 'RECORD_DECISION',
          key: 'db_driver',
          value: 'node:sqlite',
          rationale: 'built-in zero dependency',
        },
      ],
    });

    expect(reducer.getActiveFacts()).toHaveLength(1);
    expect(reducer.getActiveFacts()[0]?.fact).toBe('Project uses vitest 5.0.3');
    expect(reducer.getActiveFacts()[0]?.sourceTurnId).toBe(2);
    expect(reducer.getDecisions().get('db_driver')?.value).toBe('node:sqlite');

    // Revoke the fact in turn 4
    const firstFact = reducer.getActiveFacts()[0];
    expect(firstFact).toBeDefined();
    const factId = firstFact?.id ?? '';
    reducer.apply({
      id: 'p2',
      sourceTurnId: 4,
      cycle: 1,
      timestamp: Date.now(),
      author: 'agent',
      ops: [{ op: 'REVOKE_FACT', factId, reason: 'vitest updated to 5.0.4' }],
    });

    expect(reducer.getActiveFacts()).toHaveLength(0);
    expect(reducer.getHistory()).toHaveLength(2);
  });

  it('records invalid exploration paths to prevent doom loops', () => {
    const reducer = new EpistemicStateReducer();

    reducer.apply({
      id: 'p3',
      sourceTurnId: 1,
      cycle: 2,
      timestamp: Date.now(),
      author: 'agent',
      ops: [
        {
          op: 'MARK_PATH_INVALID',
          path: 'src/legacy/parser.ts',
          reason: 'Deprecated CJS module causing syntax errors',
        },
      ],
    });

    const invalid = reducer.getInvalidPaths().get('src/legacy/parser.ts');
    expect(invalid).toBeDefined();
    expect(invalid?.reason).toBe('Deprecated CJS module causing syntax errors');
    expect(invalid?.cycle).toBe(2);
    expect(invalid?.turn).toBe(1);
  });
});
