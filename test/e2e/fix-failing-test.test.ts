import { describe, expect, it } from 'vitest';
import { findAnthropicKey } from '../../src/auth/keys.js';
import { defaultConfig } from '../../src/config/load.js';
import { realClock } from '../../src/core/clock.js';
import { createRun } from '../../src/core/create.js';
import { runBaseline, runOneCycle } from '../../src/core/cycle.js';
import { readEvents } from '../../src/core/events.js';
import { resolvePaths } from '../../src/core/paths.js';
import { applyPlanUpdate } from '../../src/core/plan.js';
import { Run } from '../../src/core/run.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { fixtureRepo, NODE_TEST_GATE } from '../support/harness.js';
import { isolatedEnv } from '../support/tmp.js';

/**
 * Real Anthropic API. Costs money. Runs only with OMNEXX_E2E=1 and never in CI.
 *   OMNEXX_E2E=1 ANTHROPIC_API_KEY=... npm run test:e2e
 * Plan §8 M1: "make the failing test pass" is solved in one cycle for under $0.50, with a
 * cache-read share of at least 60% of input tokens from turn 3 on.
 */
const HARD_CAP_USD = 0.5;

describe.skipIf(process.env.OMNEXX_E2E !== '1')(
  'e2e (real API): fix a failing test in one cycle',
  () => {
    it('solves ts-failing-test under the hard cap with a high cache-read share', async () => {
      const env = await isolatedEnv({
        ANTHROPIC_API_KEY:
          process.env.ANTHROPIC_API_KEY ?? process.env.OMNEXX_ANTHROPIC_API_KEY ?? '',
      });
      const paths = resolvePaths(env);
      const key = await findAnthropicKey(paths, env);
      if (!key) throw new Error('OMNEXX_E2E=1 needs ANTHROPIC_API_KEY');
      const repo = await fixtureRepo('ts-failing-test');
      const config = defaultConfig({
        gates: [NODE_TEST_GATE],
        budget: { max_usd: HARD_CAP_USD, max_turns_per_cycle: 25 },
      });
      const store = await createRun({
        paths,
        cwd: repo,
        goal: 'Make the failing tests pass without changing the tests.',
        now: Date.now(),
      });
      const run = await Run.open(
        {
          config,
          paths,
          env,
          clock: realClock,
          provider: new AnthropicProvider({ apiKey: key.key, cacheTtl: '5m', timeoutMs: 120_000 }),
          fetch: globalThis.fetch,
          secrets: [key.key],
        },
        store.runId,
      );
      run.plan = applyPlanUpdate(
        undefined,
        {
          milestones: [
            {
              id: 'M1',
              title: 'Fix arithmetic',
              tasks: [
                {
                  id: 'M1.T01',
                  title: 'Make add() in src/math.js add its arguments',
                  checks: ['node --test test/'],
                },
              ],
            },
          ],
        },
        'Make the failing tests pass.',
      );
      await run.savePlan();
      await runBaseline(run);
      const verdict = await runOneCycle(run, 'M1.T01');

      expect(verdict).toMatchObject({ verdict: 'accept', done: true });
      expect(run.state.spend.usd).toBeLessThan(HARD_CAP_USD);
      const turns = (await readEvents(store.eventsPath)).filter((e) => e.type === 'turn');
      const later = turns.slice(2) as unknown as {
        tokens: { uncached: number; cacheWrite: number; cacheRead: number };
      }[];
      const input = later.reduce(
        (n, t) => n + t.tokens.uncached + t.tokens.cacheWrite + t.tokens.cacheRead,
        0,
      );
      const read = later.reduce((n, t) => n + t.tokens.cacheRead, 0);
      if (later.length) expect(read / input).toBeGreaterThanOrEqual(0.6);
      console.log(
        `e2e: $${run.state.spend.usd.toFixed(4)}, ${turns.length} turns, cache-read share from turn 3: ${later.length ? (read / input).toFixed(2) : 'n/a'}`,
      );
    });
  },
);
