import { extractSymbols, type Symbol as OutlineSymbol } from '../tools/outline.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Extract a "skeleton" view of a file: declarations (classes, functions, types) without their
 * bodies. Used for element-level localization: shows what exists without blowing up context.
 */

export interface SkeletonEntry {
  name: string;
  kind: OutlineSymbol['kind'];
  signature: string;
  startLine: number;
  endLine: number;
}

export interface FileSkeleton {
  path: string;
  language: string;
  entries: SkeletonEntry[];
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.swift': 'swift',
  '.scala': 'scala',
};

function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return LANG_BY_EXT[ext] ?? 'unknown';
}

/**
 * Extract a signature line from a declaration. Strips the body but keeps type annotations.
 */
function extractSignature(line: string, lang: string): string {
  const trimmed = line.trim();
  if (lang === 'python') {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && !trimmed.slice(colonIdx + 1).trim()) {
      return trimmed;
    }
    const match = /^((?:async\s+)?def\s+\w+\s*\([^)]*\)(?:\s*->\s*[^:]+)?)/.exec(trimmed);
    return match ? `${match[1]}:` : trimmed;
  }
  if (
    ['typescript', 'javascript', 'java', 'kotlin', 'csharp', 'rust', 'go', 'swift'].includes(lang)
  ) {
    const braceIdx = trimmed.indexOf('{');
    if (braceIdx > 0) {
      return `${trimmed.slice(0, braceIdx).trimEnd()} { ... }`;
    }
  }
  return trimmed;
}

/**
 * Build a skeleton for a single file: extract declarations and their line ranges.
 */
export function buildSkeleton(path: string, content: string): FileSkeleton {
  const lang = languageFor(path);
  const symbols = extractSymbols(content);
  const lines = content.split('\n');
  const entries: SkeletonEntry[] = [];

  for (const sym of symbols) {
    const lineIdx = lines.findIndex((l) => l.includes(sym.name));
    if (lineIdx < 0) continue;

    const signature = extractSignature(lines[lineIdx] ?? '', lang);
    const endLine = findEndLine(lines, lineIdx, lang);

    entries.push({
      name: sym.name,
      kind: sym.kind,
      signature,
      startLine: lineIdx + 1,
      endLine: endLine + 1,
    });
  }

  return { path, language: lang, entries };
}

/**
 * Find the end line of a declaration (simplified: matching braces or dedent).
 */
const INDENT_RE = /^\s*/;

function findEndLine(lines: string[], startIdx: number, lang: string): number {
  if (lang === 'python') {
    const startIndent = (INDENT_RE.exec(lines[startIdx] ?? '')?.[0] ?? '').length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      const indent = (INDENT_RE.exec(line)?.[0] ?? '').length;
      if (indent <= startIndent) return i - 1;
    }
    return lines.length - 1;
  }

  let braceCount = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const char of line) {
      if (char === '{') {
        braceCount++;
        started = true;
      } else if (char === '}') {
        braceCount--;
        if (started && braceCount === 0) return i;
      }
    }
  }
  return startIdx;
}

/**
 * Render a file skeleton as a compact string for the prompt.
 */
export function renderSkeleton(skeleton: FileSkeleton): string {
  const header = `## ${skeleton.path} (${skeleton.language})`;
  if (skeleton.entries.length === 0) {
    return `${header}\n(no declarations found)`;
  }
  const entries = skeleton.entries.map(
    (e) => `  ${e.kind} ${e.name} (L${e.startLine}-${e.endLine}): ${e.signature}`,
  );
  return [header, ...entries].join('\n');
}

/**
 * Render multiple skeletons, trimming to fit a token budget.
 */
export function renderSkeletons(skeletons: FileSkeleton[], maxTokens: number): string {
  const rendered: string[] = [];
  let totalTokens = 0;

  for (const skeleton of skeletons) {
    const text = renderSkeleton(skeleton);
    const tokens = estimateTokens(text);
    if (totalTokens + tokens > maxTokens) break;
    rendered.push(text);
    totalTokens += tokens;
  }

  return rendered.join('\n\n');
}
