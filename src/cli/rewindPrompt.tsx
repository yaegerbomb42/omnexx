import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { ACCENT, MUTED, OK } from '../tui/colors.js';
import type { DiffStats, RestoreAction, RewindTurn } from './rewind.js';
import { RESTORE_CHOICES, parseRestoreChoice } from './rewind.js';

const VISIBLE = 10;

export interface RewindPromptProps {
  turns: readonly RewindTurn[];
  checkpointing: boolean;
  width: number;
  /** Async diff stats for a turn, resolved lazily when the turn is selected. */
  loadDiffStats: (turn: RewindTurn) => Promise<DiffStats | undefined>;
  /** Resolved restore action, or 'cancel' / undefined when the user backs out. */
  onResult: (action: RestoreAction | 'cancel' | undefined) => void;
}

type Phase = 'pick' | 'restore' | 'confirm';

/**
 * Multi-phase rewind prompt. Phase 1: scroll the turn pick-list (↑↓) and pick one (enter), with
 * async diff stats for the selected turn in the footer. Phase 2 (checkpointing on): choose
 * `both` | `conversation` | `code` | `cancel`. Phase 2 (checkpointing off): legacy Y/N confirm.
 */
export function RewindPrompt({
  turns,
  checkpointing,
  width,
  loadDiffStats,
  onResult,
}: RewindPromptProps) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState('');
  const [stats, setStats] = useState<Record<string, DiffStats>>({});
  const [pendingId, setPendingId] = useState<string>();

  const safeCursor = Math.min(cursor, Math.max(0, turns.length - 1));
  const selected = turns[safeCursor];
  const start = Math.max(0, Math.min(safeCursor - Math.floor(VISIBLE / 2), turns.length - VISIBLE));
  const page = turns.slice(start, start + VISIBLE);

  useEffect(() => {
    if (!selected || stats[selected.id]) return;
    let cancelled = false;
    setPendingId(selected.id);
    void loadDiffStats(selected).then((s) => {
      if (cancelled) return;
      setPendingId(undefined);
      if (s) setStats((prev) => ({ ...prev, [selected.id]: s }));
    });
    return () => {
      cancelled = true;
    };
  }, [safeCursor, selected, stats, loadDiffStats]);

  useInput((ch, key) => {
    if (phase === 'pick') {
      if (key.escape) {
        onResult('cancel');
      } else if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow) {
        setCursor((c) => Math.min(Math.max(0, turns.length - 1), c + 1));
      } else if (key.return) {
        setPhase(checkpointing ? 'restore' : 'confirm');
        setInput('');
      }
      return;
    }

    if (key.escape) {
      setPhase('pick');
      setInput('');
      return;
    }
    if (key.return) {
      const action = parseRestoreChoice(input, checkpointing);
      if (action === 'cancel') {
        onResult('cancel');
      } else if (action) {
        onResult(action);
      }
      return;
    }
    if (key.backspace) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setInput((s) => (s + ch.toLowerCase()).slice(0, 24));
    }
  });

  const header =
    phase === 'pick'
      ? 'rewind to which turn?'
      : phase === 'restore'
        ? `rewind · ${RESTORE_CHOICES.join(' · ')}`
        : 'rewind · restore this turn?';

  const hint =
    phase === 'pick'
      ? '↑↓ · enter choose · esc cancel'
      : phase === 'restore'
        ? 'type a choice · enter confirm · esc back'
        : 'y/n · enter confirm · esc back';

  let footer = '';
  if (selected) {
    const s = stats[selected.id];
    if (s) footer = `${s.filesChanged} files · +${s.additions} −${s.deletions}`;
    else if (pendingId === selected.id) footer = 'loading diff…';
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={OK} paddingX={1} width={width}>
      <Text>
        <Text color={OK} bold>
          {header}
        </Text>
        <Text color={MUTED}>{`  ${hint}`}</Text>
      </Text>
      {phase === 'pick' &&
        page.map((t, i) => {
          const at = start + i === safeCursor;
          return (
            <Text key={t.id} inverse={at}>
              <Text
                color={at ? ACCENT : MUTED}
              >{`${String(start + i + 1).padStart(2, '0')}  `}</Text>
              <Text>{t.label}</Text>
              {t.checkpoint ? <Text color={MUTED}> ●</Text> : null}
            </Text>
          );
        })}
      {phase !== 'pick' && (
        <Text>
          <Text color={ACCENT}>› </Text>
          <Text>{selected?.label ?? ''}</Text>
        </Text>
      )}
      {phase !== 'pick' && (
        <Text color={MUTED}>
          <Text color={ACCENT}>› </Text>
          {phase === 'restore' ? input : '(y/n)'}
        </Text>
      )}
      {footer && <Text color={MUTED}>{footer}</Text>}
    </Box>
  );
}
