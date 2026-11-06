/**
 * ScriptedMockLLMProvider — a deterministic `Provider` for the daemon soak
 * and crash-resume tests.
 *
 * The daemon's executor asks this provider what to do each turn; the reply
 * is a scripted `ACTION:` line for the scenario named in the request
 * (`scenario:<id>` marker). The provider never touches the filesystem — the
 * executor carries out the action, so the mock stays a pure function of
 * (scenario, call index) and the soak is reproducible.
 *
 * Scripted replies per scenario (fixture: `fixtures/synthetic-repo`):
 * - fix-adder:       always `apply-fix adder` (one-line fix, tests go green).
 * - mode-oscillation: alternates `set-mode b` / `set-mode a`, starting with
 *   'b' (the fixture starts at 'a') — the tree hashes oscillate A→B→A.
 * - repeat-error:    always `run-failing-command` (identical stderr → trip).
 * - edit-ci:         always `edit-ci` (the executor must hit the guardrail).
 * - flaky-test:      always `quarantine-flaky` (observe, do not chase).
 */
import {
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type Provider,
} from '../../src/providers/types.js';

export type ScenarioId =
  'fix-adder' | 'mode-oscillation' | 'repeat-error' | 'edit-ci' | 'flaky-test';

export const SCENARIO_IDS: readonly ScenarioId[] = [
  'fix-adder',
  'mode-oscillation',
  'repeat-error',
  'edit-ci',
  'flaky-test',
];

export const SCENARIO_MARKERS: Readonly<Record<ScenarioId, string>> = {
  'fix-adder': 'scenario:fix-adder',
  'mode-oscillation': 'scenario:mode-oscillation',
  'repeat-error': 'scenario:repeat-error',
  'edit-ci': 'scenario:edit-ci',
  'flaky-test': 'scenario:flaky-test',
};

/** Scripted reply per scenario, as a function of the 0-based call index. */
export const SCENARIO_REPLIES: Readonly<Record<ScenarioId, (callIndex: number) => string>> = {
  'fix-adder': () => 'ACTION: apply-fix adder',
  'mode-oscillation': (callIndex) => `ACTION: set-mode ${callIndex % 2 === 0 ? 'b' : 'a'}`,
  'repeat-error': () => 'ACTION: run-failing-command',
  'edit-ci': () => 'ACTION: edit-ci',
  'flaky-test': () => 'ACTION: quarantine-flaky',
};

/** All text in a completion request (system + messages), for marker scanning. */
export function requestText(req: CompletionRequest): string {
  const parts: string[] = [
    ...req.system.map((b) => b.text),
    ...req.messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))),
  ];
  return parts.join('\n');
}

/** Which scenario a request is about, from its `scenario:<id>` marker. */
export function scenarioOf(text: string): ScenarioId | undefined {
  for (const id of SCENARIO_IDS) {
    if (text.includes(SCENARIO_MARKERS[id])) return id;
  }
  return undefined;
}

/** Minimal completion request carrying a scenario marker (what the executor sends). */
export function buildMockRequest(opts: {
  scenario: ScenarioId;
  taskTitle: string;
  turn: number;
  detail?: string;
}): CompletionRequest {
  return {
    model: 'mock',
    system: [{ text: `You are the mock implementer. ${SCENARIO_MARKERS[opts.scenario]}` }],
    tools: [],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Task: ${opts.taskTitle} (${SCENARIO_MARKERS[opts.scenario]})`,
              `Turn ${opts.turn}.`,
              opts.detail ?? '',
              'Reply with a single ACTION: line.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      },
    ],
    maxTokens: 512,
    messageBreakpoints: [],
  };
}

export class ScriptedMockLLMProvider implements Provider {
  readonly name = 'scripted-mock-llm';
  readonly requests: CompletionRequest[] = [];
  private readonly calls = new Map<ScenarioId, number>();

  /** Calls served per scenario (0 when never asked). */
  callsFor(scenario: ScenarioId): number {
    return this.calls.get(scenario) ?? 0;
  }

  reset(): void {
    this.requests.length = 0;
    this.calls.clear();
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const scenario = scenarioOf(requestText(req));
    const text =
      scenario === undefined
        ? 'ACTION: none — no scenario marker in request'
        : SCENARIO_REPLIES[scenario](this.calls.get(scenario) ?? 0);
    if (scenario !== undefined) {
      this.calls.set(scenario, (this.calls.get(scenario) ?? 0) + 1);
    }
    return Promise.resolve({
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { ...emptyUsage(), uncached: 50, output: 20 },
      model: req.model,
    });
  }
}
