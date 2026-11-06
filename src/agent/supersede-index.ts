import { createHash } from 'node:crypto';
import type { Message } from '../providers/types.js';

/**
 * Disjoint line interval representation [start, end] inclusive.
 */
export interface Interval {
  start: number;
  end: number;
}

/**
 * LineIntervalSet maintains non-overlapping, sorted line intervals for coverage queries.
 */
export class LineIntervalSet {
  private intervals: Interval[] = [];

  constructor(initial?: Interval[]) {
    if (initial) {
      for (const inv of initial) {
        this.add(inv.start, inv.end);
      }
    }
  }

  public add(start: number, end: number): void {
    let s = start;
    let e = end;
    if (s > e) {
      const tmp = s;
      s = e;
      e = tmp;
    }
    const next: Interval[] = [];
    let inserted = false;

    for (const cur of this.intervals) {
      if (inserted) {
        next.push(cur);
        continue;
      }
      if (e < cur.start - 1) {
        next.push({ start: s, end: e });
        next.push(cur);
        inserted = true;
      } else if (s > cur.end + 1) {
        next.push(cur);
      } else {
        s = Math.min(s, cur.start);
        e = Math.max(e, cur.end);
      }
    }

    if (!inserted) {
      next.push({ start: s, end: e });
    }
    this.intervals = next;
  }

  /**
   * Check if the given interval [start, end] is completely covered by this set.
   */
  public covers(start: number, end: number): boolean {
    if (start > end) return true;
    for (const inv of this.intervals) {
      if (inv.start <= start && inv.end >= end) {
        return true;
      }
    }
    return false;
  }

  public getIntervals(): readonly Interval[] {
    return this.intervals;
  }
}

const SHELL_MUTATION_REGEX =
  /\b(sed\s+-i|tee\b|mv\b|rm\b|git\s+(checkout|apply|stash|reset|merge|rebase|pull)|prettier\s+--write|eslint\s+--fix|>|>>)\b/;

const EDIT_TOOL_NAMES = new Set([
  'edit',
  'write_file',
  'str_replace',
  'replace_lines',
  'patch',
  'apply_patch',
]);

export function isFileMutation(name: string, input: Record<string, unknown>): boolean {
  if (EDIT_TOOL_NAMES.has(name)) {
    return true;
  }
  if (name === 'bash') {
    const cmd = input.command;
    if (typeof cmd === 'string') {
      return SHELL_MUTATION_REGEX.test(cmd);
    }
  }
  return false;
}

export function extractMutatedPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const directPath = input.path;
  if (typeof directPath === 'string') {
    paths.push(directPath);
  }
  const files = input.files;
  if (Array.isArray(files)) {
    for (const item of files) {
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        if (typeof itemObj.path === 'string') {
          paths.push(itemObj.path);
        }
      }
    }
  }
  return paths;
}

export const ShellMutationDetector = {
  isMutation: (name: string, input: Record<string, unknown>): boolean =>
    isFileMutation(name, input),
  mutatedPaths: (_name: string, input: Record<string, unknown>): string[] =>
    extractMutatedPaths(input),
};

/**
 * Deterministic 64-bit FNV-1a hash implementation for 3-token shingles.
 */
export function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

const MINHASH_COUNT = 64;
const BANDS = 16;
const ROWS = 4; // 16 * 4 = 64

// Precomputed pseudorandom seeds for 64 MinHash hash permutations
const HASH_SEEDS: readonly [bigint, bigint][] = (() => {
  const seeds: [bigint, bigint][] = [];
  let state = 0x123456789abcdef0n;
  for (let i = 0; i < MINHASH_COUNT; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    const a = (state | 1n) & 0xffffffffffffffffn;
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    const b = state & 0xffffffffffffffffn;
    seeds.push([a, b]);
  }
  return seeds;
})();

export function computeMinHashSignature(text: string): BigUint64Array {
  const sig = new BigUint64Array(MINHASH_COUNT);
  sig.fill(0xffffffffffffffffn);

  const norm = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 8000);
  const words = norm.split(' ').filter((w) => w.length > 0);

  if (words.length < 3) {
    const h = fnv1a64(norm);
    for (let i = 0; i < MINHASH_COUNT; i++) {
      const seedPair = HASH_SEEDS[i];
      if (seedPair) {
        const [a, b] = seedPair;
        sig[i] = (a * h + b) & 0xffffffffffffffffn;
      }
    }
    return sig;
  }

  for (let i = 0; i <= words.length - 3; i++) {
    const w0 = words[i] ?? '';
    const w1 = words[i + 1] ?? '';
    const w2 = words[i + 2] ?? '';
    const shingle = `${w0} ${w1} ${w2}`;
    const h = fnv1a64(shingle);
    for (let k = 0; k < MINHASH_COUNT; k++) {
      const seedPair = HASH_SEEDS[k];
      if (seedPair) {
        const [a, b] = seedPair;
        const val = (a * h + b) & 0xffffffffffffffffn;
        const currentVal = sig[k] ?? 0xffffffffffffffffn;
        if (val < currentVal) {
          sig[k] = val;
        }
      }
    }
  }

  return sig;
}

export function estimatedJaccardSimilarity(sigA: BigUint64Array, sigB: BigUint64Array): number {
  let match = 0;
  for (let i = 0; i < MINHASH_COUNT; i++) {
    if (sigA[i] === sigB[i]) match++;
  }
  return match / MINHASH_COUNT;
}

export function getBandBuckets(sig: BigUint64Array): string[] {
  const buckets: string[] = [];
  for (let band = 0; band < BANDS; band++) {
    const offset = band * ROWS;
    let bandHash = 0n;
    for (let r = 0; r < ROWS; r++) {
      const val = sig[offset + r] ?? 0n;
      bandHash = (bandHash * 31n + val) & 0xffffffffffffffffn;
    }
    buckets.push(`${band}:${bandHash.toString(16)}`);
  }
  return buckets;
}

export const MinHasher = {
  computeSignature: (text: string): BigUint64Array => computeMinHashSignature(text),
  estimatedJaccard: (sigA: BigUint64Array, sigB: BigUint64Array): number =>
    estimatedJaccardSimilarity(sigA, sigB),
  getBandBuckets: (sig: BigUint64Array): string[] => getBandBuckets(sig),
};

export interface SupersededObservation {
  messageIndex: number;
  blockIndex: number;
  toolUseId: string;
  reason: string;
  isCoveredInterval?: boolean | undefined;
  isExactDuplicate?: boolean | undefined;
  isNearDuplicate?: boolean | undefined;
  redundancyScore: number;
}

interface Entry {
  msgIdx: number;
  blockIdx: number;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
  size: number;
  path: string | undefined;
  command: string | undefined;
  outputHash: string;
  minhash?: BigUint64Array | undefined;
  bandBuckets?: string[] | undefined;
}

export function scanSuperseded(messages: readonly Message[]): SupersededObservation[] {
  const toolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        toolCalls.set(b.id, {
          name: b.name,
          input:
            typeof b.input === 'object' && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {},
        });
      }
    }
  }

  const entries: Entry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const b = msg.content[j];
      if (b?.type === 'tool_result') {
        const call = toolCalls.get(b.toolUseId) ?? { name: '', input: {} };
        const p = typeof call.input.path === 'string' ? call.input.path : undefined;
        const cmd = typeof call.input.command === 'string' ? call.input.command : undefined;
        const outputHash = createHash('sha256').update(b.content).digest('hex').slice(0, 16);
        entries.push({
          msgIdx: i,
          blockIdx: j,
          toolUseId: b.toolUseId,
          name: call.name,
          input: call.input,
          content: b.content,
          isError: b.isError === true,
          size: b.content.length,
          path: p,
          command: cmd,
          outputHash,
        });
      }
    }
  }

  const results: SupersededObservation[] = [];
  const fileCoverage = new Map<string, LineIntervalSet>();
  const mutatedFiles = new Set<string>();
  const seenSearches = new Set<string>();
  const seenCommands = new Map<string, { hadSuccess: boolean }>();
  const lshBuckets = new Map<string, Entry[]>();

  for (let idx = entries.length - 1; idx >= 0; idx--) {
    const cur = entries[idx];
    if (!cur) continue;

    if (isFileMutation(cur.name, cur.input)) {
      const mutated = extractMutatedPaths(cur.input);
      for (const mPath of mutated) {
        mutatedFiles.add(mPath);
        fileCoverage.delete(mPath);
      }
    }

    if (cur.name === 'bash' && cur.command) {
      const normCmd = cur.command.trim().replace(/\s+/g, ' ');
      const isNonIdempotent =
        /\b(git\s+(commit|push|tag)|npm\s+(install|publish)|rm\b|mkdir\b|mv\b)/.test(normCmd);
      const later = seenCommands.get(normCmd);
      if (!isNonIdempotent && later) {
        if (cur.isError && later.hadSuccess) {
          results.push({
            messageIndex: cur.msgIdx,
            blockIndex: cur.blockIdx,
            toolUseId: cur.toolUseId,
            reason: `\`${normCmd.slice(0, 60)}\` failed here and passed later`,
            isExactDuplicate: false,
            redundancyScore: 1.0,
          });
          continue;
        }
      }
      if (!seenCommands.has(normCmd)) {
        seenCommands.set(normCmd, { hadSuccess: !cur.isError });
      } else if (!cur.isError) {
        const cmdEntry = seenCommands.get(normCmd);
        if (cmdEntry) cmdEntry.hadSuccess = true;
      }
    }

    if (cur.name === 'grep' || cur.name === 'glob' || cur.name === 'search') {
      const searchKey = `${cur.name}:${deterministicSearchInput(cur.input)}`;
      if (seenSearches.has(searchKey)) {
        results.push({
          messageIndex: cur.msgIdx,
          blockIndex: cur.blockIdx,
          toolUseId: cur.toolUseId,
          reason: `later identical ${cur.name}`,
          isExactDuplicate: true,
          redundancyScore: 1.0,
        });
        continue;
      }
      seenSearches.add(searchKey);
    }

    if (cur.name === 'read' && cur.path) {
      const path = cur.path;
      const startLine = typeof cur.input.start === 'number' ? cur.input.start : 1;
      const endLine = typeof cur.input.end === 'number' ? cur.input.end : Number.MAX_SAFE_INTEGER;

      if (mutatedFiles.has(path)) {
        results.push({
          messageIndex: cur.msgIdx,
          blockIndex: cur.blockIdx,
          toolUseId: cur.toolUseId,
          reason: `${path} was edited after this read; read it again`,
          isCoveredInterval: false,
          redundancyScore: 0.8,
        });
      } else {
        const cov = fileCoverage.get(path);
        if (cov?.covers(startLine, endLine)) {
          results.push({
            messageIndex: cur.msgIdx,
            blockIndex: cur.blockIdx,
            toolUseId: cur.toolUseId,
            reason: `${path} was completely covered by subsequent reads`,
            isCoveredInterval: true,
            redundancyScore: 1.0,
          });
        }
      }

      if (!mutatedFiles.has(path)) {
        let cov = fileCoverage.get(path);
        if (!cov) {
          cov = new LineIntervalSet();
          fileCoverage.set(path, cov);
        }
        cov.add(startLine, endLine);
      }
    }

    if (cur.size >= 400 && !cur.isError) {
      cur.minhash = computeMinHashSignature(cur.content);
      cur.bandBuckets = getBandBuckets(cur.minhash);

      let foundCandidate: Entry | undefined;
      for (const b of cur.bandBuckets) {
        const inBucket = lshBuckets.get(b);
        if (inBucket && inBucket.length > 0) {
          for (const cand of inBucket) {
            if (cand.name === cur.name && cand.minhash) {
              const jaccard = estimatedJaccardSimilarity(cur.minhash, cand.minhash);
              if (jaccard >= 0.78) {
                foundCandidate = cand;
                break;
              }
            }
          }
        }
        if (foundCandidate) break;
      }

      if (foundCandidate) {
        results.push({
          messageIndex: cur.msgIdx,
          blockIndex: cur.blockIdx,
          toolUseId: cur.toolUseId,
          reason: `near-duplicate output of later ${cur.name}`,
          isNearDuplicate: true,
          redundancyScore: 0.9,
        });
      }

      for (const b of cur.bandBuckets) {
        let list = lshBuckets.get(b);
        if (!list) {
          list = [];
          lshBuckets.set(b, list);
        }
        if (list.length < 8) {
          list.push(cur);
        }
      }
    }
  }

  return results;
}

export const SupersedeIndex = {
  scan: (messages: readonly Message[]): SupersededObservation[] => scanSuperseded(messages),
};

function deterministicSearchInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort((a, b) => a.localeCompare(b));
  return JSON.stringify(keys.map((k) => [k, input[k]]));
}
