import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { render } from 'ink';
import type { FoundServer } from '../integrations/importers.js';
import { MIGRATE_ROLES, toModelRef } from './migrate.js';
import type { AgentTool, ExternalAgentSettings, MigratePlan, ToolScope } from './migrate.js';

/**
 * The interactive migration wizard (Ink). One row per tool+scope, with the same design tokens as
 * the non-interactive report in migrate.ts: ok for detected, muted for absent, info for the
 * frame and hints, violet for counts. Space toggles a row, enter applies the selection.
 */

interface Row {
  key: string;
  tool: AgentTool;
  scope: ToolScope;
  detected: boolean;
  parts: { text: string; role?: keyof typeof MIGRATE_ROLES }[];
}

const { ok, muted, info, warn } = MIGRATE_ROLES;

function rowParts(d: {
  settings?: ExternalAgentSettings;
  servers: readonly FoundServer[];
}): Row['parts'] {
  const parts: Row['parts'] = [];
  if (d.servers.length)
    parts.push({
      text: `${d.servers.length} server${d.servers.length === 1 ? '' : 's'}`,
      role: 'violet',
    });
  if (d.settings?.model && toModelRef(d.settings.model))
    parts.push({ text: `model ${d.settings.model}`, role: 'info' });
  if (d.settings?.envNames.length)
    parts.push({
      text: `${d.settings.envNames.length} env ${d.settings.envNames.length === 1 ? 'name' : 'names'}`,
      role: 'info',
    });
  if (d.settings?.deny.length)
    parts.push({ text: `${d.settings.deny.length} denied`, role: 'info' });
  if (d.settings?.hooks.length)
    parts.push({
      text: `${d.settings.hooks.length} hook${d.settings.hooks.length === 1 ? '' : 's'}`,
      role: 'info',
    });
  if (d.settings?.skippedHooks)
    parts.push({ text: `${d.settings.skippedHooks} skipped`, role: 'muted' });
  return parts;
}

function rowsOf(plan: MigratePlan): Row[] {
  return plan.detections.map((d) => ({
    key: `${d.tool}:${d.scope}`,
    tool: d.tool,
    scope: d.scope,
    detected: d.detected,
    parts: d.detected ? rowParts(d) : [],
  }));
}

export interface MigratePromptProps {
  plan: MigratePlan;
  /** Applies the selected items; returns one result line per item. */
  onMigrate: (ids: readonly string[]) => Promise<string[]>;
  onExit: (outcome: { cancelled: boolean; lines: string[] }) => void;
}

type Phase = 'select' | 'applying' | 'done';

export function MigratePrompt({ plan, onMigrate, onExit }: MigratePromptProps): React.ReactElement {
  const rows = rowsOf(plan);
  const selectable = rows.filter((r) => r.detected);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectable.map((r) => r.key)),
  );
  const [phase, setPhase] = useState<Phase>('select');
  const [lines, setLines] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | undefined>();

  const finish = (cancelled: boolean, finalLines: string[]): void => {
    onExit({ cancelled, lines: finalLines });
  };

  useInput((input, key) => {
    if (phase === 'applying') return;
    if (phase === 'done') {
      if (key.return || input === 'q' || key.escape || input === '\u0003') finish(false, lines);
      return;
    }
    if (key.escape || input === 'q' || input === '\u0003') {
      finish(true, []);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setNotice(undefined);
      const delta = key.upArrow ? -1 : 1;
      setCursor((c) =>
        selectable.length ? (c + delta + selectable.length) % selectable.length : 0,
      );
      return;
    }
    if (input === ' ') {
      setNotice(undefined);
      const row = selectable[cursor];
      if (!row) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      return;
    }
    if (key.return) {
      const chosen = selectable.filter((r) => selected.has(r.key));
      if (!chosen.length) {
        setNotice('nothing selected — space toggles a row');
        return;
      }
      const ids = plan.items
        .filter((i) => chosen.some((r) => r.key === `${i.tool}:${i.scope}`))
        .map((i) => i.id);
      setPhase('applying');
      void onMigrate(ids).then((result) => {
        setLines(result);
        setPhase('done');
      });
    }
  });

  const files = plan.files.length ? plan.files.join(', ') : 'no target config';
  const footer =
    phase === 'select'
      ? '↑↓ move · space toggle · enter migrate · q quit'
      : phase === 'applying'
        ? 'applying…'
        : 'applied — enter / q to close';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={info} paddingX={1} paddingY={1}>
      <Box>
        <Text bold color={info}>
          migrate
        </Text>
        <Text dimColor> bring claude-code / cursor config in</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r) => {
          const isCursor = r.detected && r.key === selectable[cursor]?.key;
          return (
            <Box key={r.key} flexDirection="row">
              <Text color={isCursor ? info : muted}>{isCursor ? '▸' : ' '}</Text>
              <Text color={r.detected && selected.has(r.key) ? ok : muted}> </Text>
              <Text color={r.detected && selected.has(r.key) ? ok : muted}>
                {r.detected && selected.has(r.key) ? '[✓] ' : '[ ] '}
              </Text>
              {r.detected ? (
                <Text bold>{r.tool.padEnd(11)}</Text>
              ) : (
                <Text bold color={muted}>
                  {r.tool.padEnd(11)}
                </Text>
              )}
              <Text dimColor> {r.scope.padEnd(7)} </Text>
              {r.detected ? <Text dimColor> </Text> : <Text dimColor>○ </Text>}
              {r.detected ? (
                <>
                  {r.parts.map((p, i) => (
                    <React.Fragment key={i}>
                      {i > 0 ? <Text dimColor> · </Text> : null}
                      <Text {...(p.role ? { color: MIGRATE_ROLES[p.role] } : {})}>{p.text}</Text>
                    </React.Fragment>
                  ))}
                </>
              ) : (
                <Text color={muted}>not detected</Text>
              )}
            </Box>
          );
        })}
        {!selectable.length ? (
          <Text dimColor>nothing detected — claude-code / cursor configs will show up here</Text>
        ) : null}
      </Box>
      {lines.length ? (
        <Box marginTop={1} flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i} color={ok}>
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>→ {files}</Text>
        {notice ? <Text color={warn}>{notice}</Text> : null}
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}

/** Render the wizard and resolve with what happened: cancelled, or the applied result lines. */
export async function showMigratePrompt(
  plan: MigratePlan,
  onMigrate: (ids: readonly string[]) => Promise<string[]>,
): Promise<{ cancelled: boolean; lines: string[] }> {
  return new Promise((resolve) => {
    const app = render(
      <MigratePrompt
        plan={plan}
        onMigrate={onMigrate}
        onExit={(outcome) => {
          app.unmount();
          resolve(outcome);
        }}
      />,
      { exitOnCtrlC: false },
    );
  });
}
