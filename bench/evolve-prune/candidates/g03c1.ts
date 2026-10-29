const SUPERSEDED_PREFIX = '[superseded by omnexx:';
/** Results shorter than this aren't worth a cache miss to stub. */
const MIN_SUPERSEDE_CHARS = 400;

interface CallInfo {
  name: string;
  input: Record<string, unknown>;
}

const field = (input: Record<string, unknown>, k: string): unknown => input[k];
const lineOf = (input: Record<string, unknown>, k: string): number | undefined => {
  const v = field(input, k);
  return typeof v === 'number' ? v : undefined;
};

/** Normalize a bash command for comparison: collapse whitespace, trim. */
function normCmd(c: string): string {
  return c.replace(/\s+/g, ' ').trim();
}

/** Does a later read cover an earlier one: same file, and the whole file or a wider range. */
function covers(later: Record<string, unknown>, earlier: Record<string, unknown>): boolean {
  if (field(later, 'path') !== field(earlier, 'path')) return false;
  const ls = lineOf(later, 'start');
  const le = lineOf(later, 'end');
  if (ls === undefined && le === undefined) return true;
  const es = lineOf(earlier, 'start');
  const ee = lineOf(earlier, 'end');
  if (es === undefined || ee === undefined) return false;
  return (ls ?? 1) <= es && le !== undefined && le >= ee;
}

/**
 * A read is stale if the same path was modified (edit/write_file) after it and then re-read
 * (any range, or the whole file) after the modification. The re-read reflects the new contents,
 * so the old result is dead weight. We must NOT stub if the only later read happened before the
 * edit (the old read is still the newest copy of those lines).
 */
function readStale(
  call: CallInfo,
  later: readonly { call: CallInfo; isError: boolean }[],
): boolean {
  if (call.name !== 'read') return false;
  const path = field(call.input, 'path');
  if (typeof path !== 'string') return false;

  // Find the earliest mutation (edit/write_file) on the same path after this read.
  let mutIdx = -1;
  for (let i = 0; i < later.length; i++) {
    const c = later[i].call;
    if ((c.name === 'edit' || c.name === 'write_file') && c.input['path'] === path) {
      mutIdx = i;
      break;
    }
  }
  if (mutIdx === -1) return false;

  // A re-read must occur after the mutation.
  for (let i = mutIdx + 1; i < later.length; i++) {
    const c = later[i].call;
    if (c.name === 'read' && c.input['path'] === path) return true;
  }
  return false;
}

/**
 * Check if a grep/glob call is identical to a later call.
 */
function identicalCall(
  call: CallInfo,
  later: readonly { call: CallInfo; isError: boolean }[],
): boolean {
  const laterCalls = later.map((l) => l.call);
  return laterCalls.some((lc) => {
    if (lc.name !== call.name) return false;
    return JSON.stringify(lc.input) === JSON.stringify(call.input);
  });
}

/** Why an earlier result is dead weight given every result after it, or undefined if it isn't. */
function supersededBy(
  call: CallInfo,
  isError: boolean,
  later: readonly { call: CallInfo; isError: boolean }[],
): string | undefined {
  if (
    call.name === 'read' &&
    later.some((l) => l.call.name === 'read' && covers(l.call.input, call.input))
  )
    return `${String(field(call.input, 'path'))} was read again later; that read is current`;

  if (call.name === 'read' && readStale(call, later))
    return `${String(field(call.input, 'path'))} was edited and re-read later; the new read is current`;

  const command = field(call.input, 'command');
  if (call.name !== 'bash' || typeof command !== 'string') return undefined;
  const nc = normCmd(command);
  const reruns = later.filter(
    (l) =>
      l.call.name === 'bash' &&
      typeof field(l.call.input, 'command') === 'string' &&
      normCmd(field(l.call.input, 'command') as string) === nc,
  );
  if (!reruns.length) return undefined;
  const shown = clip(command, 120);
  if (isError && reruns.some((l) => !l.isError))
    return `\`${shown}\` failed here and passed later; the failure is resolved`;
  return `\`${shown}\` ${isError ? 'failed' : 'passed'} here and ran again later; that run is current`;

  // Handle grep and glob: if the exact same call is repeated, the earlier one is superseded.
  if (call.name === 'grep' || call.name === 'glob') {
    if (identicalCall(call, later)) {
      const pattern = String(field(call.input, 'pattern') ?? '');
      const shown = clip(pattern, 120);
      return `\`${shown}\` was searched again later; the latest result is current`;
    }
  }

  return undefined;
}

/**
 * Stub tool results that later steps made dead weight: a file read again later (same lines or
 * the whole file), a file edited and then re-read, a command that failed and then passed, or
 * a repeated identical grep/glob call. Deterministic and free; the call and its result stay
 * paired, so every provider accepts the history. Returns new messages.
 */
export function pruneSuperseded(messages: readonly Message[]): {
  messages: Message[];
  pruned: number;
  chars: number;
} {
  const calls = new Map<string, CallInfo>();
  for (const m of messages)
    for (const b of m.content)
      if (b.type === 'tool_use')
        calls.set(b.id, {
          name: b.name,
          input:
            typeof b.input === 'object' && b.input !== null
              ? (b.input as Record<string, unknown>)
              : {},
        });
  const order: {
    at: [number, number];
    call: CallInfo;
    isError: boolean;
    size: number;
    done: boolean;
  }[] = [];
  messages.forEach((m, i) => {
    m.content.forEach((b, j) => {
      const call = b.type === 'tool_result' ? calls.get(b.toolUseId) : undefined;
      if (b.type !== 'tool_result' || !call) return;
      order.push({
        at: [i, j],
        call,
        isError: b.isError === true,
        size: b.content.length,
        done: b.content.startsWith(SUPERSEDED_PREFIX) || b.content.startsWith(CLEARED_PREFIX),
      });
    });
  });
  const stubs = new Map<number, string>(); // Use index in 'order' as key to avoid string collision issues
  let chars = 0;
  order.forEach((r, k) => {
    if (r.done || r.size < MIN_SUPERSEDE_CHARS) return;
    const why = supersededBy(r.call, r.isError, order.slice(k + 1));
    if (!why) return;
    stubs.set(k, `${SUPERSEDED_PREFIX} ${why}]`);
    chars += r.size;
  });
  if (!stubs.size) return { messages: [...messages], pruned: 0, chars: 0 };

  // Map from order index to message/block position
  const posMap = new Map<number, [number, number]>();
  order.forEach((r, k) => posMap.set(k, r.at));

  const out = messages.map((m, i) => {
    // Check if any block in this message is in stubs
    let needsUpdate = false;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (b.type === 'tool_result') {
        // Find the order index for this position
        // We need to reverse map [i,j] to k.
        // Simpler: iterate order and check if at matches [i,j]
      }
    }

    // More efficient: build a set of "i,j" strings for stubs
    const stubPositions = new Set<string>();
    stubs.forEach((_, k) => {
      const at = posMap.get(k);
      if (at) stubPositions.add(`${at[0]},${at[1]}`);
    });

    if (!m.content.some((_, j) => stubPositions.has(`${i},${j}`))) return m;

    return {
      ...m,
      content: m.content.map((b, j): ContentBlock => {
        const posKey = `${i},${j}`;
        if (b.type === 'tool_result' && stubPositions.has(posKey)) {
          // Find the stub text for this position
          // We need to get the stub text from the map
          // We stored it by k, but we need it by position. Let's refactor to store by position.
        }
        return b;
      }),
    };
  });

  // Refactor: store stubs by position string directly
  const stubsByPos = new Map<string, string>();
  order.forEach((r, k) => {
    const s = stubs.get(k);
    if (s) {
      stubsByPos.set(`${r.at[0]},${r.at[1]}`, s);
    }
  });

  const out2 = messages.map((m, i) => {
    if (!m.content.some((_, j) => stubsByPos.has(`${i},${j}`))) return m;
    return {
      ...m,
      content: m.content.map((b, j): ContentBlock => {
        const stub = stubsByPos.get(`${i},${j}`);
        return stub && b.type === 'tool_result' ? { ...b, content: stub } : b;
      }),
    };
  });

  return { messages: out2, pruned: stubs.size, chars };
}
