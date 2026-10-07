import { Text } from 'ink';
import { CYAN, GRAY, GREEN } from './colors.js';

/** How one line of a model reply renders: inside a code block, a heading, a bullet, or prose. */
export type MdKind = 'fence' | 'code' | 'heading' | 'bullet' | 'text';

/** Classify each line of a reply. Code-block state carries across lines, so this sees the whole reply. */
export function classifyMarkdown(lines: readonly string[]): MdKind[] {
  let inCode = false;
  return lines.map((l) => {
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      return 'fence';
    }
    if (inCode) return 'code';
    if (/^#{1,6}\s/.test(l)) return 'heading';
    if (/^\s*([-*]|\d+\.)\s/.test(l)) return 'bullet';
    return 'text';
  });
}

/** `code` and **bold** spans inside a prose line. Unclosed markers stay as typed. */
export function inlineSpans(line: string): { text: string; style?: 'code' | 'bold' }[] {
  const out: { text: string; style?: 'code' | 'bold' }[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    out.push(
      m[1] !== undefined ? { text: m[1], style: 'code' } : { text: m[2] ?? '', style: 'bold' },
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

function Inline({ line }: { line: string }) {
  return (
    <Text>
      {inlineSpans(line).map((s, i) =>
        s.style === 'code' ? (
          <Text key={i} color={CYAN}>
            {s.text}
          </Text>
        ) : s.style === 'bold' ? (
          <Text key={i} bold>
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

export function MarkdownLine({ text, md }: { text: string; md: MdKind }) {
  switch (md) {
    case 'fence':
      return <Text color={GRAY}>{text.replace(/^\s*```/, '──── ').trimEnd()}</Text>;
    case 'code':
      return (
        <Text>
          <Text color={GRAY}>{'│ '}</Text>
          <Text color={CYAN}>{text}</Text>
        </Text>
      );
    case 'heading':
      return (
        <Text color={GREEN} bold>
          {text.replace(/^#{1,6}\s/, '')}
        </Text>
      );
    case 'bullet': {
      const m = /^(\s*)([-*]|\d+\.)\s(.*)$/.exec(text);
      return (
        <Text>
          {m?.[1]}
          <Text color={GREEN}>{m?.[2] === '-' || m?.[2] === '*' ? '•' : m?.[2]}</Text>{' '}
          <Inline line={m?.[3] ?? text} />
        </Text>
      );
    }
    case 'text':
      return <Inline line={text} />;
  }
}
