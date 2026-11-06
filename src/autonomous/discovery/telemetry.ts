import { readFile } from 'node:fs/promises';
import { fileExists, safeJsonParse } from './common.js';
import { makeFinding, type DiscoveryCollector, type RawFinding } from './index.js';

/** Minimum occurrences of an identical crash signature before it is queued. */
const MIN_OCCURRENCES = 3;

interface CrashEntry {
  message?: string;
  stack?: string;
  timestamp?: string;
  error?: string;
}

/**
 * Parses `.omnexx/logs/crash.jsonl` (one JSON crash record per line), dedupes
 * by stack signature, and queues only signatures seen ≥3 times.
 * Returns [] when the log is absent, empty, or unparseable.
 */
export class TelemetryCollector implements DiscoveryCollector {
  readonly name = 'telemetry';

  async collect(repoRoot: string): Promise<RawFinding[]> {
    const findings: RawFinding[] = [];
    const logPath = `${repoRoot}/.omnexx/logs/crash.jsonl`;
    if (!fileExists(logPath)) return findings;

    let content: string;
    try {
      content = await readFile(logPath, 'utf8');
    } catch {
      return findings;
    }

    const bySignature = new Map<
      string,
      { count: number; firstSeen: string | null; lastSeen: string | null; sample: CrashEntry }
    >();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = safeJsonParse(trimmed) as CrashEntry | undefined;
      if (!entry) continue;
      const signature = crashSignature(entry);
      const existing = bySignature.get(signature);
      const at = entry.timestamp ?? null;
      if (existing) {
        existing.count += 1;
        if (at && (!existing.lastSeen || at > existing.lastSeen)) existing.lastSeen = at;
      } else {
        bySignature.set(signature, { count: 1, firstSeen: at, lastSeen: at, sample: entry });
      }
    }

    for (const [signature, info] of bySignature) {
      if (info.count < MIN_OCCURRENCES) continue;
      findings.push(
        makeFinding({
          collector: this.name,
          ruleOrTestId: `crash:${signature.slice(0, 80)}`,
          targetFiles: stackFiles(info.sample.stack),
          severity: 0.85,
          confidence: 0.9,
          verification: 0.7,
          findingPayload: {
            kind: 'repeated-crash',
            signature,
            occurrences: info.count,
            firstSeen: info.firstSeen,
            lastSeen: info.lastSeen,
            sampleMessage: (info.sample.message ?? info.sample.error ?? '').slice(0, 300),
          },
        }),
      );
    }
    return findings;
  }
}

/** Normalise a crash to a dedupe signature: message + first 3 stack frames. */
function crashSignature(entry: CrashEntry): string {
  const message = (entry.message ?? entry.error ?? 'unknown error').split('\n')[0]?.trim() ?? '';
  const frames = (entry.stack ?? '')
    .split('\n')
    .slice(0, 4)
    .map((line) =>
      line
        .trim()
        .replace(/:\d+:\d+\)?$/, '')
        .replace(/\(.*\)/, '(...)'),
    )
    .filter(Boolean);
  // Strip memory addresses / ids so identical crashes hash identically.
  return `${message} :: ${frames.join(' | ')}`.replace(/0x[0-9a-f]+/gi, '0x…').slice(0, 200);
}

/** Repo-relative files mentioned in a stack trace, best effort. */
function stackFiles(stack?: string): string[] {
  if (!stack) return [];
  const files = new Set<string>();
  for (const match of stack.matchAll(/(?:^|\s)(?:src|test|vscode\/src)\/[^\s:)]+\.tsx?/g)) {
    files.add(match[0].trim());
    if (files.size >= 5) break;
  }
  return [...files];
}
