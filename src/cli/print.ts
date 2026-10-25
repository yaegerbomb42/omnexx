import { attachImages } from '../tui/attach.js';
import { CodeChat, type ChatView } from '../tui/code-chat.js';
import type { CliIO } from './io.js';
import { EXIT } from './exit-codes.js';

async function readStdin(io: CliIO): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

/** What `-p --json` prints once the turn is over. Stable enough for a script to parse. */
export interface PrintResult {
  ok: boolean;
  reply: string;
  /** Narrated tool/action lines, in order. */
  actions: string[];
  /** Error lines, in order. */
  errors: string[];
  usage: {
    usd: number;
    turns: number;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    toolCalls: number;
    toolErrors: number;
  };
}

/**
 * `omnexx -p "<prompt>"`: one chat turn without the TUI, for scripts and CI. The reply goes to
 * stdout (streamed); actions, thinking and errors to stderr, so `> file` captures just the
 * answer. Nobody can answer a permission prompt, so guarded actions are refused. `-p -` reads the
 * prompt from stdin.
 *
 * With `--json` nothing but one `PrintResult` object is written to stdout: the prose, actions and
 * usage are all in that object, so a caller never has to scrape the feed.
 */
export async function printCommand(
  io: CliIO,
  prompt: string,
  opts: { model?: string; json?: boolean } = {},
): Promise<number> {
  const text = (prompt === '-' ? await readStdin(io) : prompt).trim();
  if (!text) {
    io.stderr.write('omnexx -p: empty prompt\n');
    return EXIT.error;
  }
  const json = opts.json === true;
  const chat = await CodeChat.open(io, () => Promise.resolve(false), opts.model);
  const st = { streamed: false, failed: false };
  /** One entry per turn's reply, whether it arrived streamed or as a single `out` line. */
  const replies: string[] = [];
  const actions: string[] = [];
  const errors: string[] = [];
  let streamedText = '';
  const view: ChatView = {
    stream: (d) => {
      if (!d) return;
      st.streamed = true;
      streamedText += d;
      if (!json) io.stdout.write(d);
    },
    line: (l) => {
      if (l.kind === 'out') {
        // Already streamed: just end the line. Not streamed (provider can't): print it now.
        replies.push(st.streamed ? streamedText : l.text);
        streamedText = '';
        if (!json) io.stdout.write(st.streamed ? '\n' : `${l.text}\n`);
        st.streamed = false;
        return;
      }
      if (l.kind === 'err') {
        st.failed = true;
        errors.push(l.text);
      }
      if (l.kind === 'act') actions.push(l.text);
      if (json) return;
      const mark = l.kind === 'act' ? '▸ ' : l.kind === 'think' ? 'thinking: ' : '';
      io.stderr.write(`${mark}${l.text}\n`);
    },
    todo: () => undefined,
  };
  const att = await attachImages(text, io.cwd);
  if (att.attached.length && !json) io.stderr.write(`attached ${att.attached.join(', ')}\n`);
  await chat.send(text, view, att.blocks.length ? { images: att.blocks } : {});
  if (json) {
    const t = chat.telemetry;
    // A reply that ended without an `out` line (or whose stream was cut) still has its text here.
    if (streamedText) replies.push(streamedText);
    const result: PrintResult = {
      ok: !st.failed,
      reply: replies.join('\n').trim(),
      actions,
      errors,
      usage: {
        usd: t.usd,
        turns: t.turns,
        tokens: { ...t.tokens },
        toolCalls: t.toolCalls,
        toolErrors: t.toolErrors,
      },
    };
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return st.failed ? EXIT.error : EXIT.ok;
}
