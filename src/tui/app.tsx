import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { TAGLINE, WORDMARK } from '../cli/brand.js';
import { cacheHitRate } from '../telemetry/aggregate.js';
import { fmtMs, fmtTokens } from '../telemetry/humanize.js';
import type { Entry, Session } from './session.js';

import { CYAN, GRAY, GREEN, RED } from './colors.js';
import { DiffView } from './diff.js';
import { AgentsView } from './agents.js';
import { ModelPicker, RankEditor } from './model-picker.js';
import type { TodoItem } from '../tools/todo.js';
import { MarkdownLine } from './markdown.js';
import {
  Mascot,
  mascotFrame,
  NEX_WIDTH,
  REACTION_TICKS,
  SLEEP_TICKS,
  SpeechBubble,
  type Look,
  type Mood,
} from './mascot.js';

export { CYAN, GRAY, GREEN, RED };

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Re-render whenever the session changes. */
function useSession(session: Session): void {
  const [, setVersion] = useState(0);
  useEffect(
    () =>
      session.onChange(() => {
        setVersion((v) => v + 1);
      }),
    [session],
  );
}

function EntryLine({ e }: { e: Entry }) {
  switch (e.kind) {
    case 'user':
      return (
        <Text>
          <Text color={GREEN}>{'› '}</Text>
          <Text bold>{e.text}</Text>
        </Text>
      );
    case 'act':
      return (
        <Text>
          <Text color={CYAN}>{'▸ '}</Text>
          <Text>{e.text}</Text>
        </Text>
      );
    case 'think':
      return (
        <Text color={GRAY} italic>
          {`thinking: ${e.text}`}
        </Text>
      );
    case 'system':
      return <Text color={GRAY}>{e.text}</Text>;
    case 'err':
      return <Text color={RED}>{e.text}</Text>;
    case 'out':
      return e.md ? <MarkdownLine text={e.text} md={e.md} /> : <Text>{e.text}</Text>;
    default:
      return <Text>{e.text}</Text>;
  }
}

export function Header({ version, cwd, width }: { version: string; cwd: string; width: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {width >= 60 ? (
        <Box flexDirection="column" marginBottom={1}>
          {WORDMARK.map((l) => (
            <Text key={l} color={GREEN}>
              {l}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={GREEN} bold>
          omnexx
        </Text>
      )}
      <Text>
        <Text color={CYAN}>$ omnexx</Text>
        <Text color={GRAY}>{` v${version} · ${cwd}`}</Text>
      </Text>
      <Text>{`> ${TAGLINE}`}</Text>
      <Text color={GRAY}>
        {
          '> type what you want: it works on it right here, showing every step. /run <goal> starts a long unattended run.'
        }
      </Text>
      <Text color={GRAY}>
        {
          '> /help · shift+tab chat/run mode · esc stop · ctrl+p plan · ctrl+c leave (runs keep going)'
        }
      </Text>
    </Box>
  );
}

export function WhyCard() {
  const rows: [string, string][] = [
    ['you drive, turn by turn', 'one prompt, then it drives for hours or days'],
    ['stops when the context fills', 'fresh context every cycle; never runs out'],
    ['"done" = the model says so', 'done = your tests, types and lint pass, no regressions'],
    ['stops at the literal ask', 'infers the intended build, ships it, then hardens it'],
    ['one model per session', 'Nimble routes each action to the right model'],
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={GRAY}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={GREEN} bold>
        why omnexx over claude code?
      </Text>
      {rows.map(([them, us]) => (
        <Text key={us}>
          <Text color={GRAY}>{them.padEnd(30)}</Text>
          <Text color={GREEN}>{'→ '}</Text>
          <Text>{us}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** `▰▰▰▱▱` for done of total, `width` cells. */
export function progressBar(done: number, total: number, width = 10): string {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
}

function StatusBar({ session, width }: { session: Session; width: number }) {
  const t = session.telemetry;
  const info = session.info;
  const left = session.runId ? (
    <Text wrap="truncate-end">
      <Text color={session.runAlive ? GREEN : GRAY}>{session.runAlive ? '● ' : '○ '}</Text>
      <Text color={CYAN}>{session.runId}</Text>
      {info && <Text color={GRAY}>{` · ${info.phase}`}</Text>}
      {info && info.tasks > 0 && (
        <Text>
          {' '}
          <Text color={GREEN}>{progressBar(info.done, info.tasks)}</Text>
          <Text color={GRAY}>{` ${info.done}/${info.tasks}`}</Text>
        </Text>
      )}
      <Text color={GRAY}>
        {` · ${t.startedAt && t.lastAt ? fmtMs(t.lastAt - t.startedAt) : '0s'}${t.task ? ` · ${t.task}` : ''}`}
      </Text>
    </Text>
  ) : (
    <Text color={GRAY}>no run attached</Text>
  );
  const right = statusRight(session);
  return (
    <Box width={width} justifyContent="space-between">
      {left}
      <Text color={GRAY} wrap="truncate-start">
        {right}
      </Text>
    </Box>
  );
}

/** What the empty input box suggests, by what the session is waiting for. */
function placeholderFor(session: Session): string {
  if (session.chat) return `message ${session.chat.ref} (/setup off to leave)`;
  if (session.awaiting === 'key') return 'paste the API key, then enter';
  if (session.awaiting === 'url') return '<url> [key] [--name alias]';
  if (session.pending) return 'y to allow, anything else to refuse';
  if (session.mode === 'plan')
    return session.busy
      ? 'type to steer the plan while it investigates'
      : 'what should we plan? (nothing changes until you /go)';
  if (session.mode === 'chat')
    return session.busy
      ? 'type to steer the agent while it works'
      : 'what should we build or change? (shift+tab: plan, then long run)';
  return session.runAlive ? 'steer the run, or /command' : 'what should omnexx build? (or /help)';
}

/** The status bar's right side: run telemetry, or the chat model and context use. */
function statusRight(session: Session): string {
  const t = session.telemetry;
  if (session.runId)
    return `${t.model ?? '–'} · ${fmtTokens(t.tokens.input + t.tokens.output)} tok · cache ${Math.round(cacheHitRate(t) * 100)}% · $${t.usd.toFixed(2)} · ✓${t.commits} ✗${t.rejects}`;
  if (session.mode === 'run') return `run mode · feed ${session.verbosity}`;
  const ctx = session.context;
  const used = ctx ? ` · ctx ${fmtTokens(ctx.used)}/${fmtTokens(ctx.limit)}` : '';
  return `${session.chatModelName ?? 'chat'}${used} · ${session.mode} mode`;
}

/** Width of the "omnexx" title column; Nex's eye sits right after it. */
const TITLE_WIDTH = 9;

/** The agent's checklist for the current request, OpenHands-style. */
export function TodoPanel({ items }: { items: readonly TodoItem[] }) {
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GRAY} paddingX={1} flexGrow={1}>
      <Text color={GREEN}>{`todo ${done}/${items.length}`}</Text>
      {items.map((it, i) => (
        <Text
          key={i}
          wrap="truncate-end"
          {...(it.status === 'done' ? { color: GRAY, strikethrough: true } : {})}
          {...(it.status === 'in_progress' ? { color: CYAN, bold: true } : {})}
        >
          {`${it.status === 'done' ? '☑' : it.status === 'in_progress' ? '▶' : '☐'} ${it.text}`}
        </Text>
      ))}
    </Box>
  );
}

function PlanBox({ plan, rows }: { plan: string; rows: number }) {
  const lines = plan.split('\n').slice(0, Math.max(3, rows));
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={GRAY} paddingX={1}>
      <Text color={GREEN}>plan</Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l}
        </Text>
      ))}
    </Box>
  );
}

export interface AppProps {
  session: Session;
  version: string;
  cwd: string;
  showWhy: boolean;
  pollMs?: number;
}

export function App({ session, version, cwd, showWhy, pollMs = 300 }: AppProps) {
  useSession(session);
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const width = columns || 80;
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<number | undefined>(undefined);
  const [showPlan, setShowPlan] = useState(false);
  const [tick, setTick] = useState(0);
  const frame = tick % SPINNER.length;
  // The tick a commit or rejection was last seen, so the mascot reacts for a moment.
  const seen = useRef<{ commits: number; rejects: number; at: number; mood: Mood }>({
    commits: 0,
    rejects: 0,
    at: -REACTION_TICKS,
    mood: 'happy',
  });

  useEffect(() => {
    const t = setInterval(() => {
      void session.poll();
      void session.refreshAgents();
      setTick((f) => f + 1);
    }, pollMs);
    return () => {
      clearInterval(t);
    };
  }, [session, pollMs]);

  useEffect(() => {
    if (session.quit) exit();
  });

  const wide = width >= 110;
  const suggestions = session.complete(input);
  const files = session.completeFile(input);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      exit();
      return;
    }
    if (session.rankView) {
      if (key.upArrow) void session.rankKey({ up: true });
      else if (key.downArrow) void session.rankKey({ down: true });
      else if (ch === ' ') void session.rankKey({ grab: true });
      else if (ch === 'a') void session.rankKey({ add: true });
      else if (ch === 'x' || key.backspace || key.delete) void session.rankKey({ remove: true });
      else if (key.escape || key.return || ch === 'q') void session.rankKey({ close: true });
      return;
    }
    if (session.modelPicker) {
      if (key.upArrow) session.pickerKey({ up: true });
      else if (key.downArrow) session.pickerKey({ down: true });
      else if (key.return) session.pickerKey({ enter: true });
      else if (key.escape) session.pickerKey({ close: true });
      else if (key.backspace || key.delete) session.pickerKey({ back: true });
      else if (ch && !key.ctrl && !key.meta) session.pickerKey({ char: ch });
      return;
    }
    if (session.agentsView) {
      if (key.upArrow) void session.agentsKey('up');
      else if (key.downArrow) void session.agentsKey('down');
      else if (key.return) void session.agentsKey('attach');
      else if (ch === 'p') void session.agentsKey('pause');
      else if (ch === 's') void session.agentsKey('stop');
      else if (key.escape || ch === 'q') void session.agentsKey('close');
      return;
    }
    if (session.diffView) {
      if (key.upArrow) session.diffKey('up');
      else if (key.downArrow) session.diffKey('down');
      else if (key.return || ch === ' ') session.diffKey('enter');
      else if (key.escape || ch === 'q') session.diffKey('close');
      return;
    }
    if (key.shift && key.tab) {
      session.nextMode();
      return;
    }
    if (key.ctrl && ch === 'd') {
      session.detach();
      return;
    }
    if (key.ctrl && ch === 'p') {
      setShowPlan((v) => !v);
      return;
    }
    if (key.return && (key.meta || input.endsWith('\\'))) {
      // alt+enter, or a trailing backslash, continues on a new line.
      setInput((s) => `${s.endsWith('\\') ? s.slice(0, -1) : s}\n`);
      return;
    }
    if (key.return) {
      const text = input;
      setInput('');
      setHist(undefined);
      void session.submit(text);
      return;
    }
    if (key.escape) {
      // Esc stops the agent mid-turn; with nothing running it clears the input.
      if (!session.interrupt()) setInput('');
      return;
    }
    if (key.tab) {
      const file = files[0];
      if (file) {
        setInput((s) => s.replace(/@[^\s@]*$/, `@${file} `));
        return;
      }
      const first = suggestions[0];
      if (first) setInput(`/${first.name} `);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const h = session.history;
      if (!h.length) return;
      const cur = hist ?? h.length;
      const next = key.upArrow ? Math.max(0, cur - 1) : Math.min(h.length, cur + 1);
      setHist(next);
      setInput(h[next] ?? '');
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (key.ctrl && ch === 'u') {
      setInput('');
      return;
    }
    if (!ch || key.ctrl || key.meta) return;
    // A multi-line paste stays in the box to be edited and sent with Enter.
    const body = ch.replace(/\r\n?/g, '\n');
    if (body.slice(0, -1).includes('\n')) {
      setInput((s) => s + body.replace(/\n$/, ''));
      return;
    }
    // Fast typing can arrive as one chunk that ends in Enter: submit it.
    const nl = ch.search(/[\r\n]/);
    session.touch();
    if (nl === -1) {
      setInput((s) => s + ch);
      return;
    }
    const text = (input + ch.slice(0, nl)).trim();
    setInput('');
    setHist(undefined);
    void session.submit(text);
  });

  // Run commits and rejections make Nex cheer or droop, like chat checks do.
  const { commits, rejects } = session.telemetry;
  const s0 = seen.current;
  if (commits > s0.commits) session.react('happy', 'committed!');
  else if (rejects > s0.rejects) session.react('sad', 'rejected, retrying');
  s0.commits = commits;
  s0.rejects = rejects;
  const nex = session.nex;
  const sinceReaction = (Date.now() - nex.at) / pollMs;
  const sinceActivity = (Date.now() - session.lastActivity) / pollMs;
  // Typing beats the hello wave: the eye turns to the input as soon as you start.
  const reacting =
    ['hello', 'happy', 'sad', 'startled'].includes(nex.mood) &&
    sinceReaction < REACTION_TICKS &&
    !(nex.mood === 'hello' && input);
  const mood: Mood = reacting
    ? nex.mood
    : session.busy
      ? nex.mood === 'working'
        ? 'working'
        : 'thinking'
      : session.runAlive
        ? 'working'
        : input
          ? 'listening'
          : sinceActivity > SLEEP_TICKS
            ? 'sleepy'
            : 'idle';
  const say = reacting || (session.busy && nex.mood === 'working') ? nex.say : '';
  // The eye looks down at the input box, following the cursor as the text grows.
  const lastLine = input.split('\n').at(-1) ?? '';
  const cursorCol = 4 + lastLine.length;
  const eyeCol = TITLE_WIDTH + Math.floor(NEX_WIDTH / 2);
  const look: Look = {
    x: cursorCol < eyeCol - 4 ? -1 : cursorCol > eyeCol + 4 ? 1 : 0,
    y: input ? 1 : 0,
  };
  const showMascot = width >= 60 && session.mascot;

  const placeholder = placeholderFor(session);

  return (
    <>
      <Static items={[{ id: -1 } as const, ...session.entries]}>
        {(e) =>
          e.id === -1 ? (
            <Box key="head" flexDirection="column">
              <Header version={version} cwd={cwd} width={width} />
              {showWhy && <WhyCard />}
            </Box>
          ) : (
            <EntryLine key={e.id} e={e as Entry} />
          )
        }
      </Static>
      <Box flexDirection="column" marginTop={1}>
        {showPlan && session.plan && <PlanBox plan={session.plan} rows={12} />}
        {session.diffView && <DiffView view={session.diffView} width={width} />}
        {session.agentsView && <AgentsView state={session.agentsView} width={width} />}
        {session.modelPicker && <ModelPicker state={session.modelPicker} width={width} />}
        {session.rankView && <RankEditor state={session.rankView} width={width} />}
        <Box width={width}>
          <Box flexDirection="column" flexGrow={1}>
            {session.live && (
              <Text wrap="wrap">{session.live.split('\n').slice(-6).join('\n')}</Text>
            )}
            {session.busy && (
              <Text color={CYAN}>
                {SPINNER[frame]} {session.busy}
                <Text color={GRAY}>
                  {session.mode === 'run' ? '' : '  (esc to stop, type to steer)'}
                </Text>
              </Text>
            )}
            {!wide && session.todos.length > 0 && <TodoPanel items={session.todos} />}
          </Box>
          {wide && session.todos.length > 0 && (
            <Box width={42} marginLeft={1}>
              <TodoPanel items={session.todos} />
            </Box>
          )}
        </Box>
        {session.pending && (
          <Text color={CYAN} bold>
            {`? ${session.pending.question} [y/N]`}
          </Text>
        )}
        {showMascot && (
          <Box width={width} alignItems="center">
            <Box flexDirection="column" width={TITLE_WIDTH}>
              <Text color={GREEN} bold>
                omnexx
              </Text>
              <Text color={GRAY}>{session.mode === 'run' ? 'long run' : session.mode}</Text>
            </Box>
            <Mascot mood={mood} tick={tick} say={say} look={look} />
            <SpeechBubble
              text={mascotFrame(mood, tick, say, look).caption}
              width={Math.max(20, width - TITLE_WIDTH - NEX_WIDTH - 2)}
            />
          </Box>
        )}
        <Box width={width}>
          <Box borderStyle="single" borderColor={GREEN} paddingX={1} flexGrow={1}>
            <Text color={GREEN}>{'› '}</Text>
            {input ? (
              <Text>
                {input}
                <Text color={GREEN}>█</Text>
              </Text>
            ) : (
              <Text color={GRAY}>
                <Text color={GREEN}>█</Text> {placeholder}
              </Text>
            )}
          </Box>
        </Box>
        {files.length > 0 && (
          <Box flexDirection="column" paddingX={2}>
            {files.slice(0, 6).map((f) => (
              <Text key={f} color={CYAN}>{`@${f}`}</Text>
            ))}
          </Box>
        )}
        {suggestions.length > 0 && (
          <Box flexDirection="column" paddingX={2}>
            {suggestions.slice(0, 6).map((c) => (
              <Text key={c.name}>
                <Text color={CYAN}>{`/${c.name}`.padEnd(10)}</Text>
                <Text color={GRAY}>{c.help}</Text>
              </Text>
            ))}
          </Box>
        )}
        <StatusBar session={session} width={width} />
      </Box>
    </>
  );
}
