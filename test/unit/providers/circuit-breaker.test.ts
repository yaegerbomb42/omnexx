import { describe, it, expect } from 'vitest';
import { ProviderCircuitBreaker } from '../../../src/providers/circuit-breaker.js';

describe('ProviderCircuitBreaker', () => {
  it('starts in closed state and allows requests', () => {
    const breaker = new ProviderCircuitBreaker();
    expect(breaker.state).toBe('closed');
    expect(breaker.allow()).toBe(true);
  });

  it('opens after reaching failure threshold and blocks requests', () => {
    const now = 1_000_000;
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 3,
      baseCooloffMs: 10_000,
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    expect(breaker.allow()).toBe(true);

    breaker.recordFailure(); // 3rd failure: trips open
    expect(breaker.state).toBe('open');
    expect(breaker.allow()).toBe(false);
    expect(breaker.cooldownRemaining()).toBe(10_000);
  });

  it('transitions to half-open after cooloff and allows a single canary probe', () => {
    let now = 1_000_000;
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 2,
      baseCooloffMs: 5_000,
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    // Advance clock past base cooloff
    now += 5_001;
    expect(breaker.state).toBe('half-open');

    // First call allowed as probe
    expect(breaker.allow()).toBe(true);
    // Concurrent second call blocked while probe is inflight
    expect(breaker.allow()).toBe(false);

    // Successful probe closes circuit
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.allow()).toBe(true);
  });

  it('doubles cooloff with exponential backoff on failed canary probe', () => {
    let now = 1_000_000;
    const breaker = new ProviderCircuitBreaker({
      failureThreshold: 1,
      baseCooloffMs: 2_000,
      maxCooloffMs: 10_000,
      now: () => now,
    });

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.cooldownRemaining()).toBe(2_000);

    now += 2_001;
    expect(breaker.state).toBe('half-open');
    expect(breaker.allow()).toBe(true);

    // Canary probe fails: cooloff doubles to 4,000ms
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.cooldownRemaining()).toBe(4_000);

    now += 4_001;
    expect(breaker.state).toBe('half-open');
    expect(breaker.allow()).toBe(true);

    // Canary probe fails again: cooloff doubles to 8,000ms
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.cooldownRemaining()).toBe(8_000);
  });
});
