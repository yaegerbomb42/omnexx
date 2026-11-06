import { git } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

/** Only markers younger than this are queued. */
const MAX_AGE_DAYS = 90;
/** A marker must reference a concrete symbol or issue id to be actionable. */
const REFERENCE_PATTERN =
  /(?:#\d+|[A-Z][A-Z0-9]+-\d+|`[A-Za-z_$][\w$]*`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b)/;

/**
 * Mines FIXME/BUG markers from `git grep`, enriched with `git blame` dates.
 * Only markers younger than 90 days that reference a concrete symbol or
 * issue id are queued — a bare TODO with no anchor is not actionable work.
 */
export class TodoMiningCollector implements DiscoveryCollector {
  readonly name = 'todo_mining';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const grep = await git(repoRoot, ['grep', '-nE', '(FIXME|BUG)', '--', '*.ts', '*.tsx', '*.js']);
    if (!grep) return findings;

    const now = Date.now();
    for (const line of grep.split('\n')) {
      // file.ts:123:  // FIXME: something (#456)
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!match) continue;
      const [, file, lineNo, text] = match as unknown as [string, string, string, string];
      const trimmed = text.trim();
      const kind = /\bBUG\b/.test(trimmed) ? 'BUG' : 'FIXME';
      if (!REFERENCE_PATTERN.test(trimmed)) continue;

      const blameDate = await this.blameDate(repoRoot, file, Number(lineNo));
      if (!blameDate) continue;
      const ageDays = (now - blameDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > MAX_AGE_DAYS) continue;

      const symbol = REFERENCE_PATTERN.exec(trimmed)?.[0];
      const findingInput: {
        collector: string;
        ruleOrTestId: string;
        canonicalSymbol?: string;
        targetFiles: string[];
        severity: number;
        confidence: number;
        verification: number;
        findingPayload: unknown;
      } = {
        collector: this.name,
        ruleOrTestId: `todo:${file}:${lineNo}`,
        targetFiles: [file],
        severity: 0.5,
        confidence: 0.85,
        verification: 0.7,
        findingPayload: {
          kind: 'todo-marker',
          marker: kind,
          line: Number(lineNo),
          ageDays: Math.round(ageDays * 10) / 10,
          text: trimmed.slice(0, 300),
          reference: symbol ?? null,
        },
      };
      if (symbol !== undefined) findingInput.canonicalSymbol = symbol;
      findings.push(makeFinding(findingInput));
    }
    return findings;
  }

  private async blameDate(repoRoot: string, file: string, lineNo: number): Promise<Date | null> {
    const out = await git(repoRoot, [
      'blame',
      '-L',
      `${lineNo},${lineNo}`,
      '--porcelain',
      '--',
      file,
    ]);
    const match = /author-time (\d+)/.exec(out);
    if (!match?.[1]) return null;
    return new Date(Number(match[1]) * 1000);
  }
}
