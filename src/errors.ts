/**
 * Every error Omnexx raises on purpose is an OmnexxError: a stable `code` for scripts and tests,
 * a message that says what went wrong, and a `hint` that says what to do about it.
 */
export class OmnexxError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
  }

  /** One line, suitable for a terminal: `error[code]: message (hint)`. */
  oneLine(): string {
    return `error[${this.code}]: ${this.message}${this.hint ? ` (${this.hint})` : ''}`;
  }
}

export class ConfigError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('config', message, hint);
  }
}

export class NotImplementedError extends OmnexxError {
  constructor(feature: string, milestone: string) {
    super(
      'not-implemented',
      `${feature} is not implemented in this version (planned for ${milestone})`,
      'see README "What does not work yet"',
    );
  }
}

export class PolicyError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('policy', message, hint);
  }
}

export class GitError extends OmnexxError {
  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super('git', message, hint, options);
  }
}

export class ProviderError extends OmnexxError {
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The provider's content filter refused this request; another model may take it. */
  readonly contentFilter: boolean;

  constructor(
    message: string,
    opts: {
      retryable: boolean;
      status?: number;
      hint?: string;
      cause?: unknown;
      contentFilter?: boolean;
    },
  ) {
    super('provider', message, opts.hint, { cause: opts.cause });
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.contentFilter = opts.contentFilter ?? false;
  }
}

export class LockError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('lock', message, hint);
  }
}

export class StateError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('state', message, hint);
  }
}

export class UsageError extends OmnexxError {
  constructor(message: string, hint?: string) {
    super('usage', message, hint);
  }
}

/** Render any thrown value as a single line without leaking stack traces to the user. */
export function describeError(err: unknown): string {
  if (err instanceof OmnexxError) return err.oneLine();
  if (err instanceof Error) return `error: ${err.message}`;
  return `error: ${String(err)}`;
}
