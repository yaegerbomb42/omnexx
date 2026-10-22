import { describe, expect, it } from 'vitest';
import {
  initialRepairState,
  shouldContinue,
  determineOutcome,
  buildSuccessMessage,
  renderRepairState,
  type RepairLoopConfig,
  type RepairState,
} from '../../../src/swe-bench/repair-loop.js';

describe('repair-loop', () => {
  const baseConfig: RepairLoopConfig = {
    reproTest: { command: 'npm test', files: [] },
    localization: { files: [], elements: [], lines: [], skeletons: [] },
    baseCommit: 'abc123',
    maxRounds: 5,
    requireFailToPass: true,
    requirePassToPass: true,
  };

  describe('initialRepairState', () => {
    it('creates initial state', () => {
      const state = initialRepairState();
      expect(state.round).toBe(0);
      expect(state.reproResult).toBeNull();
      expect(state.gateResults).toEqual([]);
      expect(state.allTestsPass).toBe(false);
      expect(state.reproFixed).toBe(false);
      expect(state.regressionPassed).toBe(false);
      expect(state.patch).toBeNull();
    });
  });

  describe('shouldContinue', () => {
    it('returns false when all tests pass', () => {
      const state: RepairState = {
        ...initialRepairState(),
        allTestsPass: true,
      };
      expect(shouldContinue(state, baseConfig)).toBe(false);
    });

    it('returns false when max rounds reached', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 5,
      };
      expect(shouldContinue(state, baseConfig)).toBe(false);
    });

    it('returns true when tests fail and rounds remaining', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 2,
      };
      expect(shouldContinue(state, baseConfig)).toBe(true);
    });
  });

  describe('determineOutcome', () => {
    it('returns success when all tests pass', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 2,
        allTestsPass: true,
        reproFixed: true,
        regressionPassed: true,
      };

      const outcome = determineOutcome(state, baseConfig);
      expect(outcome.success).toBe(true);
      expect(outcome.rounds).toBe(2);
    });

    it('returns failure with reason when repro fails', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 5,
        reproFixed: false,
        regressionPassed: true,
      };

      const outcome = determineOutcome(state, baseConfig);
      expect(outcome.success).toBe(false);
      expect(outcome.failureReason).toContain('reproduction test still fails');
    });

    it('returns failure with reason when regression fails', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 5,
        reproFixed: true,
        regressionPassed: false,
      };

      const outcome = determineOutcome(state, baseConfig);
      expect(outcome.success).toBe(false);
      expect(outcome.failureReason).toContain('regression tests fail');
    });
  });

  describe('buildSuccessMessage', () => {
    it('includes patch summary', () => {
      const state: RepairState = {
        ...initialRepairState(),
        allTestsPass: true,
        patch: {
          files: ['src/main.ts'],
          diff: 'diff...',
          stats: { additions: 5, deletions: 2 },
        },
      };

      const message = buildSuccessMessage(state);
      expect(message).toContain('All checks pass');
      expect(message).toContain('src/main.ts');
    });
  });

  describe('renderRepairState', () => {
    it('renders state for logging', () => {
      const state: RepairState = {
        ...initialRepairState(),
        round: 3,
        reproFixed: true,
        regressionPassed: false,
      };

      const rendered = renderRepairState(state);
      expect(rendered).toContain('Round: 3');
      expect(rendered).toContain('Repro: PASS');
      expect(rendered).toContain('Regression: FAIL');
    });
  });
});
