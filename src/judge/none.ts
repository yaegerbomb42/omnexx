import type { Judge, JudgeResult } from './types.js';

/** The default: makes no calls and always abstains. */
export class NoneJudge implements Judge {
  readonly kind = 'none';
  ask(): Promise<JudgeResult> {
    return Promise.resolve({ status: 'abstain', reason: 'judge disabled', judge: this.kind });
  }
}
