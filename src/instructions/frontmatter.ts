export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

const KEY_RE = /^[A-Za-z0-9_-]+$/;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

/**
 * Parse a leading `---` block of flat `key: value` lines (the Claude Code / Cursor frontmatter
 * format). An unclosed fence leaves the whole file as body: never destroy content we can't parse.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '').trim() !== '---') return { data: {}, body: text };
  const data: Record<string, string> = {};
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (line.trim() === '---') {
      close = i;
      break;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) continue;
    data[key] = unquote(line.slice(colon + 1).trim());
  }
  if (close === -1) return { data: {}, body: text };
  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\r?\n/, '');
  return { data, body };
}
