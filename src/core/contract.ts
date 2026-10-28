import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

export const acceptanceContractSchema = z.strictObject({
  targetFiles: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe('Exact file paths relative to repo root that will be modified'),
  hypothesis: z
    .string()
    .min(10)
    .max(2_000)
    .describe('The root cause diagnosis or architectural design approach'),
  verificationCommand: z
    .string()
    .min(3)
    .max(1_000)
    .describe('The exact shell test command to verify the change (e.g. npm test -- -t "auth")'),
});

export type AcceptanceContract = z.infer<typeof acceptanceContractSchema>;

export function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(normalize(filePath));
  }
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class ContractGate {
  private activeContract: AcceptanceContract | null = null;
  private readonly root: string;

  constructor(repoRoot: string) {
    this.root = resolve(repoRoot);
  }

  get contract(): AcceptanceContract | null {
    return this.activeContract;
  }

  hasContract(): boolean {
    return this.activeContract !== null;
  }

  registerContract(contract: AcceptanceContract): void {
    acceptanceContractSchema.parse(contract);
    this.activeContract = contract;
  }

  clearContract(): void {
    this.activeContract = null;
  }

  /**
   * Validates whether an edit to `filePath` is allowed.
   * If `requireContract` is true and no contract is registered, returns an error.
   * If a contract is registered, ensures `filePath` canonicalizes to one of `targetFiles`.
   */
  validateEdit(filePath: string, requireContract = false): { ok: boolean; error?: string } {
    if (!this.activeContract) {
      if (requireContract) {
        return {
          ok: false,
          error:
            'Pre-flight acceptance contract required before modifying code. Call define_contract with targetFiles, hypothesis, and verificationCommand first.',
        };
      }
      return { ok: true };
    }

    const editAbs = canonicalPath(resolve(this.root, filePath));
    const isTarget = this.activeContract.targetFiles.some((target) => {
      const targetAbs = canonicalPath(resolve(this.root, target));
      return samePath(editAbs, targetAbs);
    });

    if (!isTarget) {
      return {
        ok: false,
        error: `Edit targets "${filePath}", which is not listed in the active acceptance contract targetFiles: [${this.activeContract.targetFiles.join(', ')}]`,
      };
    }

    return { ok: true };
  }
}
