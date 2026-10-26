import { Box, Text } from 'ink';
import { BAD, INFO, MUTED, OK } from './colors.js';
import { BORDER, SPACE } from './tokens.js';

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  /** Hunk lines (`@@`, `+`, `-`, context), without the file headers. */
  lines: string[];
}

/** Split `git diff` output into files with their +/- counts. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  for (const line of text.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2] ?? head[1] ?? '?', added: 0, removed: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (
      !cur ||
      /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)
    )
      continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
    if (line || cur.lines.length) cur.lines.push(line);
  }
  for (const f of files) while (f.lines.at(-1) === '') f.lines.pop();
  return files;
}

export interface DiffViewState {
  title: string;
  files: DiffFile[];
  cursor: number;
  open: Set<number>;
}

const MAX_LINES_PER_FILE = 200;

export function DiffView({ view, width }: { view: DiffViewState; width: number }) {
  const total = view.files.reduce(
    (a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }),
    { added: 0, removed: 0 },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER.card}
      borderColor={MUTED}
      paddingX={SPACE.sm}
      width={width}
    >
      <Text>
        <Text color={OK} bold>
          {view.title}
        </Text>
        <Text color={MUTED}>
          {` · ${view.files.length} file${view.files.length === 1 ? '' : 's'} `}
        </Text>
        <Text color={OK}>{`+${total.added}`}</Text> <Text color={BAD}>{`-${total.removed}`}</Text>
        <Text color={MUTED}>{'  ↑↓ move · enter expand · esc close'}</Text>
      </Text>
      {view.files.length === 0 && <Text color={MUTED}>no changes</Text>}
      {view.files.map((f, i) => {
        const open = view.open.has(i);
        const shown = f.lines.slice(0, MAX_LINES_PER_FILE);
        return (
          <Box key={f.path} flexDirection="column">
            <Text inverse={i === view.cursor}>
              <Text color={MUTED}>{open ? '▾ ' : '▸ '}</Text>
              {f.path} <Text color={OK}>{`+${f.added}`}</Text>{' '}
              <Text color={BAD}>{`-${f.removed}`}</Text>
            </Text>
            {open &&
              shown.map((l, j) => (
                <Text
                  key={j}
                  wrap="truncate-end"
                  color={
                    l.startsWith('+')
                      ? OK
                      : l.startsWith('-')
                        ? BAD
                        : l.startsWith('@@')
                          ? INFO
                          : MUTED
                  }
                >
                  {`  ${l}`}
                </Text>
              ))}
            {open && f.lines.length > shown.length && (
              <Text color={MUTED}>{`  … ${f.lines.length - shown.length} more lines`}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
