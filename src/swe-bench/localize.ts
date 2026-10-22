import type { SweBenchConfig } from '../config/sections/swe-bench.js';
import type { Codemap, CodemapEntry } from '../agent/codemap.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSkeleton, renderSkeletons, type FileSkeleton } from './skeleton.js';
import { estimateTokens } from '../core/tokens.js';

/**
 * Hierarchical fault localization for SWE-bench-style issue-fix tasks.
 *
 * 1. File-level: rank files by issue relevance (LLM + heuristics)
 * 2. Element-level: within top files, identify relevant classes/functions
 * 3. Line-level: within top elements, identify exact edit locations
 */

export interface ElementLocation {
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface LineLocation {
  file: string;
  startLine: number;
  endLine: number;
  context: string;
}

export interface LocalizationResult {
  files: string[];
  elements: ElementLocation[];
  lines: LineLocation[];
  skeletons: FileSkeleton[];
}

export interface LocalizationContext {
  issue: string;
  root: string;
  codemap: Codemap;
  config: SweBenchConfig;
}

/**
 * Parse stack traces from the issue to seed localization.
 * Returns file paths mentioned in stack frames.
 */
export function parseStackTraces(issue: string): string[] {
  const files: string[] = [];

  const patterns = [
    /File "([^"]+)", line \d+/g,
    /at (?:\w+\.)*\w+ \(([^:)]+):\d+:\d+\)/g,
    /^\s+at ([^:]+):\d+:\d+$/gm,
    /([a-zA-Z_][\w/.-]+\.[a-z]+):(\d+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of issue.matchAll(pattern)) {
      const file = match[1];
      if (file && !file.includes('node_modules') && !file.startsWith('/')) {
        files.push(file);
      }
    }
  }

  return [...new Set(files)];
}

/**
 * Extract key terms from the issue for ranking.
 */
export function extractKeyTerms(issue: string): string[] {
  const errorPatterns = [
    /(?:error|exception|bug|issue|problem):\s*(\w+)/gi,
    /`([A-Z][a-zA-Z0-9_]+)`/g,
    /\b([A-Z][a-zA-Z0-9_]+Error)\b/g,
    /\b([a-z_][a-zA-Z0-9_]+)\(\)/g,
  ];

  const terms: string[] = [];
  for (const pattern of errorPatterns) {
    for (const match of issue.matchAll(pattern)) {
      if (match[1]) terms.push(match[1]);
    }
  }

  return [...new Set(terms)];
}

/**
 * Score a file by its relevance to the issue.
 * Higher score = more likely to need editing.
 */
function scoreFile(
  entry: CodemapEntry,
  issue: string,
  stackFiles: string[],
  keyTerms: string[],
): number {
  let score = 0;

  if (stackFiles.some((sf) => entry.path.endsWith(sf) || sf.endsWith(entry.path))) {
    score += 100;
  }

  const pathParts = entry.path.toLowerCase().split('/');
  const issueLower = issue.toLowerCase();

  for (const part of pathParts) {
    if (issueLower.includes(part) && part.length > 2) {
      score += 20;
    }
  }

  for (const symbol of entry.symbols) {
    const symName = symbol.split(' ').pop() ?? '';
    if (issueLower.includes(symName.toLowerCase()) && symName.length > 2) {
      score += 30;
    }
    for (const term of keyTerms) {
      if (symName.toLowerCase().includes(term.toLowerCase())) {
        score += 15;
      }
    }
  }

  if (entry.kind === 'source') score += 10;
  if (entry.kind === 'test') score -= 5;

  if (entry.purpose) {
    const purposeLower = entry.purpose.toLowerCase();
    for (const term of keyTerms) {
      if (purposeLower.includes(term.toLowerCase())) {
        score += 10;
      }
    }
  }

  return score;
}

/**
 * File-level localization: rank files by issue relevance.
 */
export function localizeToFiles(ctx: LocalizationContext): string[] {
  const { issue, codemap, config } = ctx;
  const stackFiles = config.parse_stack_traces ? parseStackTraces(issue) : [];
  const keyTerms = extractKeyTerms(issue);

  const scored = codemap.entries
    .filter((e) => e.kind === 'source' || e.kind === 'test')
    .map((e) => ({ path: e.path, score: scoreFile(e, issue, stackFiles, keyTerms) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, config.localize_top_files).map((s) => s.path);
}

/**
 * Element-level localization: extract skeletons and rank elements.
 */
export async function localizeToElements(
  ctx: LocalizationContext,
  files: string[],
): Promise<{ skeletons: FileSkeleton[]; elements: ElementLocation[] }> {
  const { root, issue, config } = ctx;
  const skeletons: FileSkeleton[] = [];
  const allElements: ElementLocation[] = [];

  for (const file of files) {
    try {
      const content = await readFile(join(root, file), 'utf8');
      const skeleton = buildSkeleton(file, content);
      skeletons.push(skeleton);

      for (const entry of skeleton.entries) {
        allElements.push({
          file,
          name: entry.name,
          kind: entry.kind,
          startLine: entry.startLine,
          endLine: entry.endLine,
        });
      }
    } catch {
      continue;
    }
  }

  const issueLower = issue.toLowerCase();
  const keyTerms = extractKeyTerms(issue);

  const scored = allElements.map((el) => {
    let score = 0;

    if (issueLower.includes(el.name.toLowerCase())) {
      score += 50;
    }

    for (const term of keyTerms) {
      if (el.name.toLowerCase().includes(term.toLowerCase())) {
        score += 20;
      }
    }

    if (el.kind === 'function' || el.kind === 'method') score += 5;

    return { element: el, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const topElements = scored
    .slice(0, config.localize_top_elements * files.length)
    .map((s) => s.element);

  return { skeletons, elements: topElements };
}

/**
 * Line-level localization: extract code context for top elements.
 */
export async function localizeToLines(
  ctx: LocalizationContext,
  elements: ElementLocation[],
): Promise<LineLocation[]> {
  const { root } = ctx;
  const lines: LineLocation[] = [];
  const fileContents = new Map<string, string[]>();

  for (const el of elements) {
    let content = fileContents.get(el.file);
    if (!content) {
      try {
        const text = await readFile(join(root, el.file), 'utf8');
        content = text.split('\n');
        fileContents.set(el.file, content);
      } catch {
        continue;
      }
    }

    const startIdx = Math.max(0, el.startLine - 1);
    const endIdx = Math.min(content.length, el.endLine);
    const contextLines = content.slice(startIdx, endIdx);

    lines.push({
      file: el.file,
      startLine: el.startLine,
      endLine: el.endLine,
      context: contextLines.join('\n'),
    });
  }

  return lines;
}

/**
 * Full hierarchical localization pipeline.
 */
export async function localize(ctx: LocalizationContext): Promise<LocalizationResult> {
  const files = localizeToFiles(ctx);

  const { skeletons, elements } = await localizeToElements(ctx, files);

  const lines = await localizeToLines(ctx, elements);

  return { files, elements, lines, skeletons };
}

/**
 * Render localization result for the prompt.
 */
export function renderLocalization(result: LocalizationResult, maxTokens: number): string {
  const sections: string[] = [];

  sections.push('# Fault Localization');
  sections.push('');
  sections.push('## Suspect Files');
  sections.push(result.files.map((f, i) => `${i + 1}. ${f}`).join('\n'));
  sections.push('');

  const skeletonText = renderSkeletons(result.skeletons, Math.floor(maxTokens * 0.6));
  if (skeletonText) {
    sections.push('## File Skeletons');
    sections.push(skeletonText);
    sections.push('');
  }

  if (result.elements.length > 0) {
    sections.push('## Suspect Elements');
    for (const el of result.elements.slice(0, 10)) {
      sections.push(`- ${el.file}:${el.startLine}-${el.endLine} ${el.kind} ${el.name}`);
    }
  }

  const text = sections.join('\n');
  if (estimateTokens(text) <= maxTokens) return text;

  const minSections = sections.slice(0, 5);
  return minSections.join('\n');
}
