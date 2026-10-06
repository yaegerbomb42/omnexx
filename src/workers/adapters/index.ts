import type { WorkerBackend } from '../types.js';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from './claude-code.js';
import { CodexAdapter, type CodexAdapterOptions } from './codex.js';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode.js';
import { AiderAdapter, type AiderAdapterOptions } from './aider.js';
import { GeminiCliAdapter, type GeminiCliAdapterOptions } from './gemini-cli.js';
import { QwenCodeAdapter, type QwenCodeAdapterOptions } from './qwen-code.js';
import { ClineAdapter, type ClineAdapterOptions } from './cline.js';

export {
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  AiderAdapter,
  GeminiCliAdapter,
  QwenCodeAdapter,
  ClineAdapter,
};

export interface AdapterOptionsMap {
  'claude-code'?: ClaudeCodeAdapterOptions;
  codex?: CodexAdapterOptions;
  opencode?: OpenCodeAdapterOptions;
  aider?: AiderAdapterOptions;
  'gemini-cli'?: GeminiCliAdapterOptions;
  'qwen-code'?: QwenCodeAdapterOptions;
  cline?: ClineAdapterOptions;
  [key: string]: unknown;
}

export function createWorkerAdapter(
  id: string,
  options: {
    readonly path?: string;
    readonly timeoutMs?: number;
    readonly extraArgs?: readonly string[];
  } = {},
): WorkerBackend | undefined {
  switch (id) {
    case 'claude-code':
      return new ClaudeCodeAdapter(options);
    case 'codex':
      return new CodexAdapter(options);
    case 'opencode':
      return new OpenCodeAdapter(options);
    case 'aider':
      return new AiderAdapter(options);
    case 'gemini-cli':
      return new GeminiCliAdapter(options);
    case 'qwen-code':
      return new QwenCodeAdapter(options);
    case 'cline':
      return new ClineAdapter(options);
    default:
      return undefined;
  }
}
