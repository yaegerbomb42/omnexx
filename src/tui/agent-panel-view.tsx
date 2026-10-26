import { Box, Text } from 'ink';
import { INFO, MUTED, OK } from './colors.js';
import { BORDER, SPACE } from './tokens.js';
import { panelLines, type AgentPanelState } from './agent-panel.js';

const NAME_WIDTH = 18;

/** The `/settings` panel (and the launch offer): one compact screen, Enter accepts. */
export function AgentPanel({ state, width }: { state: AgentPanelState; width: number }) {
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER.panel}
      borderColor={OK}
      paddingX={SPACE.sm}
      width={width}
    >
      <Text>
        <Text color={OK} bold>
          {state.startup ? 'agent settings for this session' : 'agent settings'}
        </Text>
        <Text color={MUTED}>{'  tab move · ←→ change · enter save · esc cancel'}</Text>
      </Text>
      {panelLines(state).map((line, i) => {
        const focused = i === state.focus;
        return (
          <Text key={line.row} wrap="truncate-end">
            <Text color={focused ? INFO : MUTED}>{focused ? '› ' : '  '}</Text>
            <Text bold={focused}>{line.name.padEnd(NAME_WIDTH)}</Text>
            {line.bar && <Text color={focused ? INFO : MUTED}>{`${line.bar}  `}</Text>}
            <Text {...(focused ? { color: INFO } : {})}>{line.value}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
