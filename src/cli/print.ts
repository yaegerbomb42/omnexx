import { CodeChat, type ChatView } from '../tui/code-chat.js';
import type { CliIO } from './io.js';
import { EXIT } from './exit-codes.js';

async function readStdin(io: CliIO): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `omnexx -p "<prompt>"`: one chat turn without the TUI, for scripts and CI. The reply goes to
 * stdout (streamed); actions, thinking and errors to stderr, so `> file` captures just the
 * answer. Nobody can answer a permission prompt, so guarded actions are refused. `-p -` reads the
 * prompt from stdin.
 */
export async function printCommand(
  io: CliIO,
  prompt: string,
  opts: { model?: string } = {},
): Promise<number> {
  const text = (prompt === '-' ? await readStdin(io) : prompt).trim();
  if (!text) {
    io.stderr.write('omnexx -p: empty prompt\n');
    return EXIT.error;
  }
  const chat = await CodeChat.open(io, () => Promise.resolve(false), opts.model);
  const st = { streamed: false, failed: false };
  const view: ChatView = {
    stream: (d) => {
      if (!d) return;
      st.streamed = true;
      io.stdout.write(d);
    },
    line: (l) => {
      if (l.kind === 'out') {
        // Already streamed: just end the line. Not streamed (provider can't): print it now.
        io.stdout.write(st.streamed ? '\n' : `${l.text}\n`);
        st.streamed = false;
      } else {
        if (l.kind === 'err') st.failed = true;
        const mark = l.kind === 'act' ? '▸ ' : l.kind === 'think' ? 'thinking: ' : '';
        io.stderr.write(`${mark}${l.text}\n`);
      }
    },
    todo: () => undefined,
  };
  await chat.send(text, view);
  return st.failed ? EXIT.error : EXIT.ok;
}
