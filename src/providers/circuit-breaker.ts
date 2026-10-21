/**
 * Provider-level Circuit Breaker with exponential backoff and half-open canary probing.
 * Prevents cascading latency spirals when a provider or model endpoint suffers an outage or severe 5xx flood.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderCircuitOptions {
  /** Consecutive errors before opening the circuit. Defaults to 5. */
  failureThreshold?: number;
  /** Initial backoff duration in ms before attempting half-open probe. Defaults to 10,000ms (10s). */
  baseCooloffMs?: number;
  /** Max backoff duration in ms. Defaults to 300,000ms (5 minutes). */
  maxCooloffMs?: number;
  /** Custom clock for deterministic testing. */
  now?: () => number;
}

export class ProviderCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private currentCooloffMs: number;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly baseCooloffMs: number;
  private readonly maxCooloffMs: number;
  private readonly now: () => number;

  constructor(options: ProviderCircuitOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.baseCooloffMs = options.baseCooloffMs ?? 10_000;
    this.maxCooloffMs = options.maxCooloffMs ?? 300_000;
    this.currentCooloffMs = this.baseCooloffMs;
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    const elapsed = this.now() - this.openedAt;
    return elapsed >= this.currentCooloffMs ? 'half-open' : 'open';
  }

  /**
   * Returns true if a request to this provider is permitted.
   * Closed: all allowed.
   * Half-Open: exactly 1 canary probe allowed at a time.
   * Open: blocked until cooloff expires.
   */
  allow(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  /**
   * Record a successful completion. Closes the circuit and resets backoff.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.currentCooloffMs = this.baseCooloffMs;
    this.probing = false;
  }

  /**
   * Record a network / 5xx / outage failure.
   * If threshold is reached, opens the circuit with exponential backoff.
   */
  recordFailure(): void {
    this.probing = false;
    this.consecutiveFailures++;

    if (this.openedAt !== undefined) {
      // Failed while half-open: double the cooloff and re-open
      this.currentCooloffMs = Math.min(this.maxCooloffMs, this.currentCooloffMs * 2);
      this.openedAt = this.now();
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }

  /**
   * Milliseconds remaining until the next probe attempt is allowed.
   */
  cooldownRemaining(): number {
    if (this.openedAt === undefined) return 0;
    const elapsed = this.now() - this.openedAt;
    return Math.max(0, this.currentCooloffMs - elapsed);
  }
}
