import type { JudgeUse } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import { MIN_OLLAMA, versionAtLeast } from './endpoint.js';
import {
  answersMatch,
  JUDGE_CHARS_PER_TOKEN,
  MAX_BODY_BYTES,
  MAX_PROMPT_TOKENS,
  validateQuestions,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type JudgeResult,
} from './types.js';

export interface NimbleOptions {
  url: string;
  model: string;
  timeoutMs: number;
  keepAlive: string;
  fetch: typeof fetch;
  clock: Clock;
}

type RawAnswer = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function probs(v: unknown): Record<string, number> | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) {
    const n = num(x);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

/** Map one raw answer to our typed answer, or undefined when its shape is wrong. */
export function parseAnswer(q: JudgeQuestion, raw: RawAnswer): JudgeAnswer | undefined {
  if (q.type === 'choice') {
    const choice = raw.choice;
    const p = probs(raw.probabilities);
    const confidence = num(raw.confidence);
    if (typeof choice !== 'string' || !p || confidence === undefined) return undefined;
    return { id: q.id, type: 'choice', choice, probabilities: p, confidence };
  }
  if (q.type === 'noul') {
    const probability = num(raw.probability) ?? num(raw.p_true);
    return probability === undefined ? undefined : { id: q.id, type: 'noul', probability };
  }
  const score = num(raw.score);
  const p = probs(raw.probabilities);
  const confidence = num(raw.confidence);
  if (score === undefined || !p || confidence === undefined) return undefined;
  return { id: q.id, type: 'score', score, probabilities: p, confidence };
}

/**
 * Nimble on Ollama: `POST {url}/v1/systemone` with `{model, state, questions, keep_alive}`.
 * Questions go out as `{name, type, question, options|levels}`; answers come back keyed by
 * name (an object, or an array of objects with `name`). Every failure becomes an abstain.
 */
export class NimbleJudge implements Judge {
  readonly kind = 'nimble';
  private versionOk: boolean | undefined;

  constructor(private readonly opts: NimbleOptions) {}

  private get base(): string {
    return this.opts.url.replace(/\/+$/, '');
  }

  private abstain(reason: string): JudgeResult {
    return { status: 'abstain', reason, judge: this.kind };
  }

  private async checkVersion(signal: AbortSignal): Promise<string | undefined> {
    if (this.versionOk) return undefined;
    const res = await this.opts.fetch(`${this.base}/api/version`, { signal });
    if (!res.ok) return `version check HTTP ${res.status}`;
    const v = ((await res.json()) as { version?: unknown }).version;
    if (typeof v !== 'string' || !versionAtLeast(v, MIN_OLLAMA))
      return `ollama ${String(v)} is older than 0.35.0`;
    this.versionOk = true;
    return undefined;
  }

  async ask(
    _use: JudgeUse,
    state: unknown,
    questions: readonly JudgeQuestion[],
  ): Promise<JudgeResult> {
    const invalid = validateQuestions(questions);
    if (invalid) return this.abstain(`invalid questions: ${invalid}`);
    const body = JSON.stringify({
      model: this.opts.model,
      state,
      questions: questions.map((q) => ({
        name: q.id,
        type: q.type,
        question: q.prompt,
        ...(q.type === 'choice'
          ? { options: q.options }
          : q.type === 'score'
            ? { levels: q.levels }
            : {}),
      })),
      keep_alive: this.opts.keepAlive,
    });
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_BODY_BYTES) return this.abstain(`request too large (${bytes} bytes)`);
    if (bytes / JUDGE_CHARS_PER_TOKEN > MAX_PROMPT_TOKENS)
      return this.abstain('prompt over 8192 tokens');
    const started = this.opts.clock.now();
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    try {
      const versionProblem = await this.checkVersion(signal);
      if (versionProblem) return this.abstain(versionProblem);
      const res = await this.opts.fetch(`${this.base}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) return this.abstain(`HTTP ${res.status}`);
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return this.abstain('malformed JSON');
      }
      const rawAnswers = (data as { answers?: unknown }).answers;
      const byName = new Map<string, RawAnswer>();
      if (Array.isArray(rawAnswers)) {
        for (const a of rawAnswers as RawAnswer[])
          if (typeof a.name === 'string') byName.set(a.name, a);
      } else if (typeof rawAnswers === 'object' && rawAnswers !== null) {
        for (const [k, v] of Object.entries(rawAnswers))
          if (typeof v === 'object' && v !== null) byName.set(k, v as RawAnswer);
      } else return this.abstain('malformed response: no answers');
      const answers: JudgeAnswer[] = [];
      for (const q of questions) {
        const raw = byName.get(q.id);
        const a = raw ? parseAnswer(q, raw) : undefined;
        if (!a) return this.abstain(`malformed answer for ${q.id}`);
        answers.push(a);
      }
      const mismatch = answersMatch(questions, answers);
      if (mismatch) return this.abstain(`answer mismatch: ${mismatch}`);
      return {
        status: 'answered',
        answers,
        judge: this.kind,
        latencyMs: this.opts.clock.now() - started,
        model: this.opts.model,
        inputBytes: bytes,
        endpointHost: new URL(this.base).host,
      };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError')
        return this.abstain(`timeout after ${this.opts.timeoutMs} ms`);
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return this.abstain(
        cause === 'ECONNREFUSED' ? 'connection refused' : `network error: ${cause ?? e.message}`,
      );
    }
  }
}
