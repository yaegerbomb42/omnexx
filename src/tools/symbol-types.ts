/** A block of source: a definition with its line range. */
export interface SourceBlock {
  file: string;
  start: number;
  end: number;
  lines: string[];
}

/** One line pointing somewhere: a caller's or callee's signature, or a candidate definition. */
export interface SymbolRef {
  file: string;
  line: number;
  text: string;
}

export interface SymbolFound {
  kind: 'found';
  engine: 'typescript' | 'heuristic';
  def: SourceBlock;
  types: SourceBlock[];
  callers: SymbolRef[];
  callees: SymbolRef[];
  /** How many callers/callees there were before the cap. */
  callerTotal: number;
  calleeTotal: number;
}

export type SymbolResult =
  | SymbolFound
  | { kind: 'ambiguous'; candidates: SymbolRef[] }
  | { kind: 'missing'; suggestions: string[] };

export interface SymbolQuery {
  symbol: string;
  /** File or folder, relative to the repo root, the definition must be in. */
  path?: string;
  depth: 0 | 1;
}

/** Callers and callees kept at depth 1. */
export const MAX_REFS = 10;
/** Signature types expanded. */
export const MAX_TYPES = 6;
/** A ref line is cut to this many characters. */
export const REF_CHARS = 160;
