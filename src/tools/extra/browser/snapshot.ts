import { estimateTokens } from '../../../core/tokens.js';

export const MAX_SNAPSHOT_TOKENS = 4_000;

/**
 * Trims accessibility tree snapshot to at most maxTokens (default 4000).
 * Preserves hierarchical integrity where possible and appends a "…N more nodes" footer if truncated.
 */
export function trimSnapshot(snapshot: string, maxTokens = MAX_SNAPSHOT_TOKENS): string {
  if (estimateTokens(snapshot) <= maxTokens) {
    return snapshot;
  }

  const lines = snapshot.split('\n');
  const keptLines: string[] = [];
  let remainingNodes = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Calculate what the text would be with this line plus the truncation footer
    const testLines = [...keptLines, line, `… ${lines.length - (i + 1)} more nodes`];
    if (estimateTokens(testLines.join('\n')) > maxTokens) {
      remainingNodes = lines.length - i;
      break;
    }
    keptLines.push(line);
  }

  if (remainingNodes > 0) {
    keptLines.push(`… ${remainingNodes} more nodes`);
    return keptLines.join('\n');
  }

  return snapshot;
}
