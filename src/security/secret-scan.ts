import { matchesAny } from './glob.js';

/**
 * Common known secret token signatures (extended from redact.ts patterns).
 */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'Private Key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: 'Anthropic API Key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    name: 'OpenAI API Key',
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'GitHub Personal Access Token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  {
    name: 'GitHub Fine-Grained Token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    name: 'AWS Access Key ID',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'Slack Token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'NPM Token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  },
  {
    name: 'JSON Web Token (JWT)',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'GitLab Personal Access Token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'Google AI / API Key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    name: 'Stripe Secret Key',
    pattern: /\b(?:sk|rk)_(?:test|live)_[0-9a-zA-Z]{24,}\b/g,
  },
  {
    name: 'HuggingFace Token',
    pattern: /\bhf_[A-Za-z0-9]{34,}\b/g,
  },
];

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly matched: string;
  readonly rule: 'regex' | 'entropy';
}

export interface SecretScanResult {
  readonly clean: boolean;
  readonly findings: readonly SecretFinding[];
}

/**
 * Calculates Shannon entropy (base 2) for a given string.
 */
export function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of str) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Determines whether a token on an added line looks like a raw high-entropy secret.
 * Criteria:
 * - Length between 24 and 128 characters
 * - Alphanumeric/hex/base64/symbols charset
 * - High Shannon entropy (typically >= 4.5 for alphanumeric / random strings)
 * - Excludes pure repeated characters or standard URLs, file paths, hashes, etc.
 */
const HIGH_ENTROPY_TOKEN = /(?<=["'\s=:,]|^)[A-Za-z0-9+/_\-!@#$%^&*()]{24,128}(?=["'\s=:,]|$)/g;

function isHighEntropySecret(token: string): boolean {
  // If token is just a single character repeated or very low unique char count, ignore.
  const uniqueChars = new Set(token).size;
  if (uniqueChars < 16) return false;

  // Ignore git commit SHAs (40 hex chars) or common hex digests (32 hex / md5, 64 hex / sha256)
  if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(token)) {
    return false;
  }

  // Calculate Shannon entropy
  const entropy = shannonEntropy(token);
  return entropy >= 4.5;
}

/**
 * Scans a unified patch (or individual file additions) for committed secrets.
 * Only lines added (`+`, excluding `+++`) are inspected.
 */
export function scanPatchForSecrets(
  patch: string,
  options: { readonly allowlist?: readonly string[] } = {},
): SecretScanResult {
  const allowlist = options.allowlist ?? [];
  const findings: SecretFinding[] = [];

  const lines = patch.split('\n');
  let currentFile = '';
  let lineInFile = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice(6).trim();
      lineInFile = 0;
      continue;
    } else if (rawLine.startsWith('+++ ')) {
      currentFile = rawLine.slice(4).trim();
      lineInFile = 0;
      continue;
    }

    if (rawLine.startsWith('@@ ')) {
      // Hunk header: @@ -old,count +new,count @@
      const match = /\+([0-9]+)/.exec(rawLine);
      if (match?.[1]) {
        lineInFile = parseInt(match[1], 10) - 1;
      }
      continue;
    }

    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) {
      if (!rawLine.startsWith('-')) {
        lineInFile++;
      }
      continue;
    }

    lineInFile++;
    const content = rawLine.slice(1); // strip leading '+'

    // Check allowlist for the current file
    if (currentFile && matchesAny(currentFile, allowlist)) {
      continue;
    }

    // 1. Regex checks
    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (match) {
        findings.push({
          file: currentFile || 'unknown',
          line: lineInFile,
          reason: `Potential ${name} detected`,
          matched: match[0],
          rule: 'regex',
        });
      }
    }

    // 2. High entropy checks on suspicious tokens in added lines
    HIGH_ENTROPY_TOKEN.lastIndex = 0;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = HIGH_ENTROPY_TOKEN.exec(content)) !== null) {
      const token = tokenMatch[0];
      // Skip if already captured by regex
      if (
        findings.some((f) => f.file === currentFile && f.line === lineInFile && f.matched === token)
      ) {
        continue;
      }

      if (isHighEntropySecret(token)) {
        findings.push({
          file: currentFile || 'unknown',
          line: lineInFile,
          reason: `High-entropy secret candidate detected (entropy ${shannonEntropy(token).toFixed(2)})`,
          matched: token,
          rule: 'entropy',
        });
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}

/**
 * Scans raw text / content of a file for secrets.
 */
export function scanTextForSecrets(
  filePath: string,
  content: string,
  options: { readonly allowlist?: readonly string[] } = {},
): SecretScanResult {
  const allowlist = options.allowlist ?? [];
  if (matchesAny(filePath, allowlist)) {
    return { clean: true, findings: [] };
  }

  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNum = i + 1;

    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        findings.push({
          file: filePath,
          line: lineNum,
          reason: `Potential ${name} detected`,
          matched: match[0],
          rule: 'regex',
        });
      }
    }

    HIGH_ENTROPY_TOKEN.lastIndex = 0;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = HIGH_ENTROPY_TOKEN.exec(line)) !== null) {
      const token = tokenMatch[0];
      if (findings.some((f) => f.line === lineNum && f.matched === token)) {
        continue;
      }
      if (isHighEntropySecret(token)) {
        findings.push({
          file: filePath,
          line: lineNum,
          reason: `High-entropy secret candidate detected (entropy ${shannonEntropy(token).toFixed(2)})`,
          matched: token,
          rule: 'entropy',
        });
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}
