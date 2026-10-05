import { parseDuration } from '../config/duration.js';
import type { OmnexxConfig } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { Redactor } from '../security/redact.js';
import { CircuitBreaker, FailOpenJudge, type JudgeEvents } from './fail-open.js';
import type { LlmJudge } from './llm.js';
import { NimbleJudge } from './nimble.js';
import { NoneJudge } from './none.js';

export interface JudgeDeps {
  config: OmnexxConfig;
  clock: Clock;
  events: JudgeEvents;
  redactor: Redactor;
  fetch: typeof fetch;
  /** Built lazily by the caller because it needs the provider and the budget. */
  llm: () => LlmJudge;
}

export function createJudge(deps: JudgeDeps): FailOpenJudge {
  const j = deps.config.judge;
  const primary =
    j.kind === 'nimble'
      ? new NimbleJudge({
          url: j.nimble.url,
          model: j.nimble.model,
          timeoutMs: j.nimble.timeout_ms,
          keepAlive: j.nimble.keep_alive,
          fetch: deps.fetch,
          clock: deps.clock,
        })
      : j.kind === 'llm'
        ? deps.llm()
        : new NoneJudge();
  const fallback =
    j.kind !== 'none' && j.kind !== 'llm' && j.fallback === 'llm' ? deps.llm() : undefined;
  const breaker = new CircuitBreaker(
    j.nimble.breaker_failures,
    parseDuration(j.nimble.breaker_reprobe),
    deps.clock,
  );
  return new FailOpenJudge(primary, fallback, breaker, deps.events, deps.redactor, new Set(j.uses));
}
