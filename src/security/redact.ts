/**
 * The redaction filter runs on every event, log line, judge payload and notification.
 * It masks (1) the exact values of secret-looking env vars and (2) common token formats.
 */

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
export const MASK = '[REDACTED]';

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export class Redactor {
  private readonly values: string[];

  constructor(values: Iterable<string> = []) {
    // Longest first so a value that contains another is masked whole. Short values cause false hits.
    this.values = [...new Set([...values].filter((v) => v.length >= 8))].sort(
      (a, b) => b.length - a.length,
    );
  }

  static fromEnv(env: NodeJS.ProcessEnv, extra: Iterable<string> = []): Redactor {
    const values = Object.entries(env)
      .filter(([name, v]) => v !== undefined && isSecretEnvName(name))
      .map(([, v]) => v as string);
    return new Redactor([...values, ...extra]);
  }

  withValues(values: Iterable<string>): Redactor {
    return new Redactor([...this.values, ...values]);
  }

  text(input: string): string {
    let out = input;
    for (const v of this.values) out = out.split(v).join(MASK);
    for (const re of PATTERNS) out = out.replace(re, MASK);
    return out;
  }

  /** Deep-redact any JSON-like value. Object keys are kept; string leaves are masked. */
  value<T>(input: T): T {
    return this.walk(input) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.walk(x)]));
    }
    return v;
  }
}
