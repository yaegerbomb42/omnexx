import { Box, Static, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';
import { TAGLINE, WORDMARK } from '../cli/brand.js';
import { cacheHitRate } from '../telemetry/aggregate.js';
import { fmtMs, fmtTokens } from '../telemetry/humanize.js';
import type { Entry, Session } from './session.js';

export const GREEN = '#00FF41';
export const CYAN = '#00E5FF';
export const GRAY = '#666666';
export const RED = '#FF3B30';

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
    case 'system':
      return <Text color={GRAY}>{e.text}</Text>;
    case 'err':
      return <Text color={RED}>{e.text}</Text>;
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
        {'> type a goal and press enter. it plans, builds, checks every step, and keeps going.'}
      </Text>
      <Text color={GRAY}>
        {'> /help for commands · ctrl+p plan · ctrl+c leave (runs keep going)'}
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

function StatusBar({ session, width }: { session: Session; width: number }) {
  const t = session.telemetry;
  const left = session.runId ? (
    <Text>
      <Text color={session.runAlive ? GREEN : GRAY}>{session.runAlive ? '● ' : '○ '}</Text>
      <Text color={CYAN}>{session.runId}</Text>
      <Text color={GRAY}>
        {` · ${t.startedAt && t.lastAt ? fmtMs(t.lastAt - t.startedAt) : '0s'} · cycle ${t.cycle}${t.task ? ` · ${t.task}` : ''}`}
      </Text>
    </Text>
  ) : (
    <Text color={GRAY}>no run attached</Text>
  );
  const right = session.runId
    ? `${t.model ?? '–'} · ${fmtTokens(t.tokens.input + t.tokens.output)} tok · cache ${Math.round(cacheHitRate(t) * 100)}% · $${t.usd.toFixed(2)} · ✓${t.commits} ✗${t.rejects}`
    : `feed ${session.verbosity}`;
  return (
    <Box width={width} justifyContent="space-between">
      {left}
      <Text color={GRAY}>{right}</Text>
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
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      void session.poll();
      setFrame((f) => (f + 1) % SPINNER.length);
    }, pollMs);
    return () => {
      clearInterval(t);
    };
  }, [session, pollMs]);

  useEffect(() => {
    if (session.quit) exit();
  });

  const suggestions = session.complete(input);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      exit();
      return;
    }
    if (key.ctrl && ch === 'p') {
      setShowPlan((v) => !v);
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
      setInput('');
      return;
    }
    if (key.tab) {
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
    // A paste (or fast typing) can arrive as one chunk that ends in Enter: submit it.
    const nl = ch.search(/[\r\n]/);
    if (nl === -1) {
      setInput((s) => s + ch);
      return;
    }
    const text = (input + ch.slice(0, nl)).trim();
    setInput('');
    setHist(undefined);
    void session.submit(text);
  });

  const placeholder = session.chat
    ? `message ${session.chat.ref} (/chat off to leave)`
    : session.runAlive
      ? 'steer the run, or /command'
      : 'what should omnexx build? (or /help)';

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
        {session.busy && (
          <Text color={CYAN}>
            {SPINNER[frame]} {session.busy}
          </Text>
        )}
        <Box borderStyle="single" borderColor={GREEN} paddingX={1} width={width}>
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
