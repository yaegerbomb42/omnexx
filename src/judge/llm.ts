import { z } from 'zod';
import type { JudgeUse } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { ResolvedModel } from '../providers/pricing.js';
import type { CompletionRequest, CompletionResponse } from '../providers/types.js';
import {
  answersMatch,
  validateQuestions,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type JudgeResult,
} from './types.js';

export interface LlmJudgeOptions {
  clock: Clock;
  /**
   * Runs the call on the cheap chain: budget-gated, routed, spend recorded. Undefined means the
   * budget refused it (the judge then abstains).
   */
  complete: (
    req: Omit<CompletionRequest, 'model' | 'route'>,
    estimatedInputTokens: number,
    maxOutputTokens: number,
  ) => Promise<{ res: CompletionResponse; model: ResolvedModel } | undefined>;
  maxTokens?: number;
}

const answerSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      choice: z.string().optional(),
      probability: z.number().min(0).max(1).optional(),
      score: z.number().optional(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * The `cheap` model answers the same typed questions through a forced tool call. It costs money,
 * so it's opt-in and every call goes through the budget gate. An LLM has no calibrated
 * probabilities: the chosen option gets its stated confidence and the rest share the remainder.
 */
export class LlmJudge implements Judge {
  readonly kind = 'llm';

  constructor(private readonly opts: LlmJudgeOptions) {}

  async ask(
    use: JudgeUse,
    state: unknown,
    questions: readonly JudgeQuestion[],
  ): Promise<JudgeResult> {
    const abstain = (reason: string): JudgeResult => ({
      status: 'abstain',
      reason,
      judge: this.kind,
    });
    const invalid = validateQuestions(questions);
    if (invalid) return abstain(`invalid questions: ${invalid}`);
    const stateText = JSON.stringify(state);
    const qText = questions
      .map((q) =>
        q.type === 'choice'
          ? `- ${q.id} (choice): ${q.prompt} Options: ${q.options.join(', ')}`
          : q.type === 'noul'
            ? `- ${q.id} (true/false): ${q.prompt} Give "probability" that it is true.`
            : `- ${q.id} (score 0-${q.levels.length - 1}): ${q.prompt} Levels: ${q.levels.join(' < ')}`,
      )
      .join('\n');
    const prompt = `You are a terse decision function for an autonomous coding harness (use: ${use}). Answer every question using only the state.\n\nState:\n${stateText}\n\nQuestions:\n${qText}`;
    const maxTokens = this.opts.maxTokens ?? 1_024;
    const started = this.opts.clock.now();
    let done: { res: CompletionResponse; model: ResolvedModel } | undefined;
    try {
      done = await this.opts.complete(
        {
          system: [{ text: 'Reply only by calling the answer tool.' }],
          tools: [
            {
              name: 'answer',
              description: 'Submit answers',
              inputSchema: z.toJSONSchema(answerSchema),
            },
          ],
          toolChoice: { type: 'tool', name: 'answer' },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens,
          messageBreakpoints: [],
        },
        Math.ceil(prompt.length / 3) + 400,
        maxTokens,
      );
    } catch (err) {
      return abstain(`provider error: ${(err as Error).message}`);
    }
    if (!done) return abstain('budget');
    const { res, model } = done;
    const call = res.content.find((b) => b.type === 'tool_use');
    const parsed = answerSchema.safeParse(call?.type === 'tool_use' ? call.input : undefined);
    if (!parsed.success) return abstain('malformed tool answer');
    const answers: JudgeAnswer[] = [];
    for (const q of questions) {
      const a = parsed.data.answers.find((x) => x.id === q.id);
      if (!a) return abstain(`missing answer for ${q.id}`);
      if (q.type === 'noul') {
        if (a.probability === undefined) return abstain(`no probability for ${q.id}`);
        answers.push({ id: q.id, type: 'noul', probability: a.probability });
        continue;
      }
      const options = q.type === 'choice' ? q.options : q.levels;
      const picked = q.type === 'choice' ? a.choice : options[Math.round(a.score ?? -1)];
      if (picked === undefined || !options.includes(picked))
        return abstain(`invalid pick for ${q.id}`);
      const rest = (1 - a.confidence) / (options.length - 1);
      const probabilities = Object.fromEntries(
        options.map((o) => [o, o === picked ? a.confidence : rest]),
      );
      answers.push(
        q.type === 'choice'
          ? { id: q.id, type: 'choice', choice: picked, probabilities, confidence: a.confidence }
          : {
              id: q.id,
              type: 'score',
              score: options.indexOf(picked),
              probabilities,
              confidence: a.confidence,
            },
      );
    }
    const mismatch = answersMatch(questions, answers);
    if (mismatch) return abstain(mismatch);
    return {
      status: 'answered',
      answers,
      judge: this.kind,
      latencyMs: this.opts.clock.now() - started,
      model: model.id,
      inputBytes: Buffer.byteLength(prompt),
      endpointHost: model.provider === 'anthropic' ? 'api.anthropic.com' : model.provider,
    };
  }
}
