import { acceptanceContractSchema } from '../core/contract.js';
import { fail, ok, type Tool } from './types.js';

export const defineContractTool: Tool<typeof acceptanceContractSchema> = {
  name: 'define_contract',
  description:
    'Register the 3-part acceptance contract (targetFiles, hypothesis, verificationCommand) before modifying code.',
  schema: acceptanceContractSchema,
  readOnly: false,
  run(input, ctx) {
    if (!ctx.contractGate) {
      return Promise.resolve(
        ok(
          `Acceptance contract recorded: ${String(input.targetFiles.length)} target files, verification command: ${input.verificationCommand}`,
        ),
      );
    }
    try {
      ctx.contractGate.registerContract(input);
      return Promise.resolve(
        ok(
          `Pre-flight acceptance contract registered successfully.\n- Target Files: ${input.targetFiles.join(', ')}\n- Hypothesis: ${input.hypothesis}\n- Verification Command: ${input.verificationCommand}\nModifications are now strictly locked to target files.`,
        ),
      );
    } catch (err) {
      return Promise.resolve(
        fail(
          `Failed to register acceptance contract: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
