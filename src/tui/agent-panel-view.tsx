import { Box, Text } from 'ink';
import { CYAN, GRAY, GREEN } from './colors.js';
import { panelLines, type AgentPanelState } from './agent-panel.js';

const NAME_WIDTH = 18;

/** The `/settings` panel (and the launch offer): one compact screen, Enter accepts. */
export function AgentPanel({ state, width }: { state: AgentPanelState; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={GREEN} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          {state.startup ? 'agent settings for this session' : 'agent settings'}
        </Text>
        <Text color={GRAY}>{'  tab move · ←→ change · enter save · esc cancel'}</Text>
      </Text>
      {panelLines(state).map((line, i) => {
        const focused = i === state.focus;
        return (
          <Text key={line.row} wrap="truncate-end">
            <Text color={focused ? CYAN : GRAY}>{focused ? '› ' : '  '}</Text>
            <Text bold={focused}>{line.name.padEnd(NAME_WIDTH)}</Text>
            {line.bar && <Text color={focused ? CYAN : GRAY}>{`${line.bar}  `}</Text>}
            <Text {...(focused ? { color: CYAN } : {})}>{line.value}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
