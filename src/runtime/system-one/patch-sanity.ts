/** Gate 5: refuse lazy or truncated edits before they reach disk. */
import type { SystemOneClient } from './client.js';
import { patchSignals, placeholderProb } from './features.js';
import { noul, score, scoreValue, type SystemOneBackendKind } from './types.js';

export const COMPLETENESS_RUBRIC = [
  '1: Truncated or broken syntax',
  '2: Incomplete replacement dropping surrounding code',
  '3: Partial edit with questionable omissions',
  '4: Complete edit with minor style gaps',
  '5: Complete, clean, self-contained edit',
] as const;

export const PLACEHOLDER_QUESTION =
  "Does this patch introduce lazy placeholder comments (e.g., '// existing code...', '// rest of implementation', '// TODO: implement') that erase existing logic when replacing non-comment code?";

export interface PatchVerdict {
  reject: boolean;
  placeholderProb: number;
  completeness: number;
  confidence: number;
  placeholders: string[];
  droppedCodeLines: number;
  backend: SystemOneBackendKind;
  latencyMs: number;
}

export async function assessPatch(
  client: SystemOneClient,
  patch: { path: string; oldText: string; newText: string },
  threshold: number,
): Promise<PatchVerdict> {
  const r = await client.systemOne({
    gate: 'patch',
    state: {
      path: patch.path,
      oldText: patch.oldText.slice(0, 12_000),
      newText: patch.newText.slice(0, 12_000),
    },
    questions: {
      diff_completeness: score(
        'Rate the completeness and structural integrity of this code edit',
        COMPLETENESS_RUBRIC,
      ),
      has_lazy_placeholders: noul(PLACEHOLDER_QUESTION),
    },
  });
  const sig = patchSignals(patch.oldText, patch.newText);
  // Placeholder comments that replace no real code (new docs, tests about comments) never count;
  // when real code did go missing, the calibrated features are a floor under the model's answer.
  const remote = r.answers.has_lazy_placeholders.prob;
  const prob =
    sig.droppedCodeLines > 0 ? Math.max(remote, placeholderProb(sig)) : Math.min(remote, 0.2);
  const completeness = scoreValue(r.answers.diff_completeness);
  const confidence = r.answers.diff_completeness.confidence;
  const reject = prob > threshold || (completeness < 2 && confidence >= 0.8);
  return {
    reject,
    placeholderProb: prob,
    completeness,
    confidence,
    placeholders: sig.placeholders,
    droppedCodeLines: sig.droppedCodeLines,
    backend: r.backend,
    latencyMs: r.latencyMs,
  };
}

export function rejectionMessage(path: string, v: PatchVerdict): string {
  const what = v.placeholders.length
    ? `it replaces ${String(v.droppedCodeLines)} line(s) of existing code with placeholder comment(s) ${v.placeholders
        .slice(0, 3)
        .map((p) => `"${p}"`)
        .join(', ')}`
    : `it looks truncated (completeness ${String(v.completeness)}/5)`;
  return `[system1:patch-sanity] Rejected before writing ${path}: ${what} (placeholder prob=${v.placeholderProb.toFixed(2)}). Nothing was written. Re-send the edit with the complete code, keeping every line you meant to keep.`;
}
