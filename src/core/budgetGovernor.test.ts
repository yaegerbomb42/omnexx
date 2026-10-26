import { describe, expect, it } from 'vitest';
import { BudgetGovernor } from './budgetGovernor.js';
import type { BudgetStorage, PriceCard } from './budgetGovernor.js';

const priceCard: PriceCard = { m: { input: 0.01, output: 0.02 } };

/** In-memory spend store shared across governor instances to simulate a restart. */
class MemoryStorage implements BudgetStorage {
  private spent = 0;

  load(): number {
    return this.spent;
  }

  save(value: number): void {
    this.spent = value;
  }
}

const call = (
  promptTokens: number,
  outputTokens: number,
): { promptTokens: number; outputTokens: number; model: string } => ({
  promptTokens,
  outputTokens,
  model: 'm',
});

describe('BudgetGovernor', () => {
  it('blocks an over-budget call and invokes the blocked prompt callback', () => {
    let prompted = 0;
    const governor = new BudgetGovernor({
      storage: new MemoryStorage(),
      priceCard,
      sessionCap: 1,
      onBlocked: () => {
        prompted += 1;
      },
    });

    expect(governor.check(call(50, 50)).allowed).toBe(false);
    expect(prompted).toBe(1);
  });

  it('allows an under-budget call without prompting', () => {
    let prompted = 0;
    const governor = new BudgetGovernor({
      storage: new MemoryStorage(),
      priceCard,
      sessionCap: 10,
      onBlocked: () => {
        prompted += 1;
      },
    });

    expect(governor.check(call(50, 50)).allowed).toBe(true);
    expect(prompted).toBe(0);
  });

  it('loads persisted spend after a restart and accounts for it', () => {
    const storage = new MemoryStorage();
    const first = new BudgetGovernor({ storage, priceCard, sessionCap: 2 });

    // Each call costs 1.5, so after the first call 1.5 is spent and 0.5 remains.
    expect(first.check(call(50, 50)).allowed).toBe(true);
    first.persist();

    let prompted = 0;
    const restarted = new BudgetGovernor({
      storage,
      priceCard,
      sessionCap: 2,
      onBlocked: () => {
        prompted += 1;
      },
    });

    // 1.5 (already spent) + 1.5 (next call) exceeds the 2 cap.
    expect(restarted.check(call(50, 50)).allowed).toBe(false);
    expect(prompted).toBe(1);
  });
});
