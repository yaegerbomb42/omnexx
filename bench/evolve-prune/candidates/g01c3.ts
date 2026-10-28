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

/** Are two grep/glob inputs identical? */
function sameSearchInput(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (field(a, 'pattern') !== field(b, 'pattern')) return false;
  const ap = field(a, 'path');
  const bp = field(b, 'path');
  if (ap === undefined && bp === undefined) return true;
  if (ap === undefined || bp === undefined) return false;
  return ap === bp;
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
  const command = field(call.input, 'command');
  if (call.name !== 'bash' || typeof command !== 'string') return undefined;
  const reruns = later.filter(
    (l) => l.call.name === 'bash' && field(l.call.input, 'command') === command,
  );
  if (!reruns.length) return undefined;
  const shown = clip(command, 120);
  if (isError && reruns.some((l) => !l.isError))
    return `\`${shown}\` failed here and passed later; the failure is resolved`;
  return `\`${shown}\` ${isError ? 'failed' : 'passed'} here and ran again later; that run is current`;
}

/**
 * Stub tool results that later steps made dead weight: a file read again later (same lines or
 * the whole file), and a command that failed and then passed. Deterministic and free; the call
 * and its result stay paired, so every provider accepts the history. Returns new messages.
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
  const stubs = new Map<string, string>();
  let chars = 0;
  order.forEach((r, k) => {
    if (r.done || r.size < MIN_SUPERSEDE_CHARS) return;
    const later = order.slice(k + 1);
    let why: string | undefined;
    if (r.call.name === 'read') {
      if (later.some((l) => l.call.name === 'read' && covers(l.call.input, r.call.input)))
        why = `${String(field(r.call.input, 'path'))} was read again later; that read is current`;
    } else if (r.call.name === 'bash') {
      const command = field(r.call.input, 'command');
      if (typeof command === 'string') {
        const reruns = later.filter(
          (l) => l.call.name === 'bash' && field(l.call.input, 'command') === command,
        );
        if (reruns.length) {
          const shown = clip(command, 120);
          if (r.isError && reruns.some((l) => !l.isError))
            why = `\`${shown}\` failed here and passed later; the failure is resolved`;
          else
            why = `\`${shown}\` ${r.isError ? 'failed' : 'passed'} here and ran again later; that run is current`;
        }
      }
    } else if (r.call.name === 'grep' || r.call.name === 'glob') {
      if (later.some((l) => l.call.name === r.call.name && sameSearchInput(l.call.input, r.call.input)))
        why = `a later identical ${r.call.name} call is current`;
    }
    if (!why) return;
    stubs.set(String(r.at), `${SUPERSEDED_PREFIX} ${why}]`);
    chars += r.size;
  });
  if (!stubs.size) return { messages: [...messages], pruned: 0, chars: 0 };
  const out = messages.map((m, i) => {
    if (!m.content.some((_, j) => stubs.has(String([i, j])))) return m;
    return {
      ...m,
      content: m.content.map((b, j): ContentBlock => {
        const stub = stubs.get(String([i, j]));
        return stub && b.type === 'tool_result' ? { ...b, content: stub } : b;
      }),
    };
  });
  return { messages: out, pruned: stubs.size, chars };
}
