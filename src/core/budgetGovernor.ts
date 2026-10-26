/** Price per token for a model's input and output. */
export interface ModelPrices {
  input: number;
  output: number;
}

/** Maps a model name to its per-token input/output prices. */
export type PriceCard = Readonly<Record<string, ModelPrices>>;

/** Persistence backing store for the governor's cumulative spend. */
export interface BudgetStorage {
  load(): number;
  save(spent: number): void;
}

/** Options for constructing a {@link BudgetGovernor}. */
export interface BudgetGovernorOptions {
  storage: BudgetStorage;
  priceCard: PriceCard;
  sessionCap: number;
  /** Invoked when a call is blocked so the host can prompt the user. */
  onBlocked?: () => void;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Interval between automatic persistence flushes (default: one minute). */
  persistIntervalMs?: number;
}

/**
 * A pre-flight budget governor: it estimates the cost of the next tool call and
 * blocks it when doing so would exceed the session cap. The cumulative spend is
 * persisted every minute so it survives restarts.
 */
export class BudgetGovernor {
  private readonly storage: BudgetStorage;
  private readonly priceCard: PriceCard;
  private readonly sessionCap: number;
  private readonly onBlocked: (() => void) | undefined;
  private readonly now: () => number;
  private readonly persistIntervalMs: number;
  private spent: number;
  private lastPersistedAt: number;

  constructor(options: BudgetGovernorOptions) {
    this.storage = options.storage;
    this.priceCard = options.priceCard;
    this.sessionCap = options.sessionCap;
    this.onBlocked = options.onBlocked;
    this.now = options.now ?? Date.now;
    this.persistIntervalMs = options.persistIntervalMs ?? 60_000;
    this.spent = this.storage.load();
    this.lastPersistedAt = this.now();
  }

  /**
   * Estimate the cost of the next call and decide whether it is allowed under
   * the session cap. When blocked, the blocked-prompt callback is invoked.
   */
  check(call: { promptTokens: number; outputTokens: number; model: string }): {
    allowed: boolean;
  } {
    const cost = this.estimateCost(call.promptTokens, call.outputTokens, call.model);
    if (this.spent + cost > this.sessionCap) {
      this.onBlocked?.();
      return { allowed: false };
    }
    this.spent += cost;
    this.maybePersist();
    return { allowed: true };
  }

  /** Force a persistence flush (e.g., before shutdown or for tests). */
  persist(): void {
    this.storage.save(this.spent);
    this.lastPersistedAt = this.now();
  }

  private estimateCost(promptTokens: number, outputTokens: number, model: string): number {
    const prices = this.priceCard[model];
    if (prices === undefined) return 0;
    return promptTokens * prices.input + outputTokens * prices.output;
  }

  private maybePersist(): void {
    if (this.now() - this.lastPersistedAt >= this.persistIntervalMs) {
      this.storage.save(this.spent);
      this.lastPersistedAt = this.now();
    }
  }
}
