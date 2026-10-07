import { Box, Text } from 'ink';
import { CYAN, GRAY, GREEN, RED } from './colors.js';

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
    <Box flexDirection="column" borderStyle="single" borderColor={GRAY} paddingX={1} width={width}>
      <Text>
        <Text color={GREEN} bold>
          {view.title}
        </Text>
        <Text color={GRAY}>
          {` · ${view.files.length} file${view.files.length === 1 ? '' : 's'} `}
        </Text>
        <Text color={GREEN}>{`+${total.added}`}</Text>{' '}
        <Text color={RED}>{`-${total.removed}`}</Text>
        <Text color={GRAY}>{'  ↑↓ move · enter expand · esc close'}</Text>
      </Text>
      {view.files.length === 0 && <Text color={GRAY}>no changes</Text>}
      {view.files.map((f, i) => {
        const open = view.open.has(i);
        const shown = f.lines.slice(0, MAX_LINES_PER_FILE);
        return (
          <Box key={f.path} flexDirection="column">
            <Text inverse={i === view.cursor}>
              <Text color={GRAY}>{open ? '▾ ' : '▸ '}</Text>
              {f.path} <Text color={GREEN}>{`+${f.added}`}</Text>{' '}
              <Text color={RED}>{`-${f.removed}`}</Text>
            </Text>
            {open &&
              shown.map((l, j) => (
                <Text
                  key={j}
                  wrap="truncate-end"
                  color={
                    l.startsWith('+')
                      ? GREEN
                      : l.startsWith('-')
                        ? RED
                        : l.startsWith('@@')
                          ? CYAN
                          : GRAY
                  }
                >
                  {`  ${l}`}
                </Text>
              ))}
            {open && f.lines.length > shown.length && (
              <Text color={GRAY}>{`  … ${f.lines.length - shown.length} more lines`}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
