/**
 * Turns a browser's raw console and network buffers into the small, prioritized report an agent
 * can act on: uncaught exceptions first, then console errors and warnings, then HTTP failures and
 * requests that never completed. Duplicates (a server logging the same error every render) collapse.
 */

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  /** Why the request never got a response (DNS, refused, aborted). */
  failure?: string;
}

export interface BrowserConsoleIssue {
  type: string;
  text: string;
  location?: string;
}

export interface BrowserRequestIssue {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  failure?: string;
}

export interface BrowserDiagnostics {
  /** Console entries of type error/assert. */
  errors: number;
  /** Console warnings, reported after errors. */
  warnings: number;
  /** HTTP 4xx/5xx plus requests that failed at the network layer. */
  failedRequests: number;
  console: BrowserConsoleIssue[];
  requests: BrowserRequestIssue[];
  /** "2 console errors, 1 failed request" or "no frontend errors". */
  summary: string;
}

export interface DiagnosticsInput {
  console: readonly ConsoleEntry[];
  requests: readonly NetworkEntry[];
}

export interface DiagnosticsOptions {
  /** Cap each list; default 20. */
  limit?: number;
  /** Include console warnings (default true; errors are always included). */
  includeWarnings?: boolean;
}

/** A short, stable id for de-duplicating an entry across repeated renders. */
const key = (parts: readonly (string | number | undefined)[]): string =>
  parts.map((p) => (p === undefined ? '' : String(p))).join('\u0000');

const clip = (text: string, max = 500): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Whether a request is a failure worth reporting. */
export function isFailedRequest(r: NetworkEntry): boolean {
  return r.status === undefined || r.status >= 400;
}

/** Whether a console entry is an error (or a warning, when asked). */
export function isProblemConsole(m: ConsoleEntry, includeWarnings = true): boolean {
  return (
    m.type === 'error' ||
    m.type === 'assert' ||
    m.type === 'pageerror' ||
    (includeWarnings && m.type === 'warning')
  );
}

export function collectBrowserDiagnostics(
  input: DiagnosticsInput,
  opts: DiagnosticsOptions = {},
): BrowserDiagnostics {
  const limit = Math.max(1, opts.limit ?? 20);
  const includeWarnings = opts.includeWarnings ?? true;
  const seen = new Set<string>();
  const consoleIssues: BrowserConsoleIssue[] = [];
  const requests: BrowserRequestIssue[] = [];

  // Exceptions before ordinary console noise; warnings last.
  const rank = (m: ConsoleEntry): number =>
    m.type === 'pageerror' ? 0 : m.type === 'error' || m.type === 'assert' ? 1 : 2;
  const sorted = input.console
    .filter((m) => isProblemConsole(m, includeWarnings))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);

  let errors = 0;
  let warnings = 0;
  for (const { m } of sorted) {
    const isWarning = m.type === 'warning';
    if (isWarning) warnings++;
    else errors++;
    const id = key(['console', m.type, m.text]);
    if (seen.has(id) || consoleIssues.length >= limit) continue;
    seen.add(id);
    consoleIssues.push({
      type: m.type,
      text: clip(m.text),
      ...(m.location ? { location: m.location } : {}),
    });
  }

  for (const r of input.requests) {
    if (!isFailedRequest(r)) continue;
    const id = key(['request', r.method, r.url, r.status]);
    if (seen.has(id) || requests.length >= limit) continue;
    seen.add(id);
    requests.push({
      method: r.method,
      url: clip(r.url),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.resourceType ? { resourceType: r.resourceType } : {}),
      ...(r.failure ? { failure: clip(r.failure, 200) } : {}),
    });
  }

  return {
    errors,
    warnings,
    failedRequests: input.requests.filter(isFailedRequest).length,
    console: consoleIssues,
    requests,
    summary: describe(errors, warnings, input.requests.filter(isFailedRequest).length),
  };
}

function describe(errors: number, warnings: number, failed: number): string {
  const parts: string[] = [];
  if (errors) parts.push(`${String(errors)} console error${errors === 1 ? '' : 's'}`);
  if (failed) parts.push(`${String(failed)} failed request${failed === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${String(warnings)} warning${warnings === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'no frontend errors';
}

export function hasDiagnostics(d: BrowserDiagnostics): boolean {
  return d.errors > 0 || d.failedRequests > 0 || d.warnings > 0;
}

/** The report appended to a page-changing action's output, or the `diagnostics` action body. */
export function formatBrowserDiagnostics(
  d: BrowserDiagnostics,
  opts: { heading?: string; maxLines?: number } = {},
): string {
  const maxLines = Math.max(1, opts.maxLines ?? 12);
  const lines: string[] = [];
  for (const m of d.console) {
    const where = m.location ? ` (${m.location})` : '';
    lines.push(`  [${m.type}] ${m.text}${where}`);
  }
  for (const r of d.requests) {
    const status =
      r.status === undefined ? (r.failure ? `FAILED ${r.failure}` : 'FAILED') : String(r.status);
    lines.push(`  ${status} ${r.method} ${r.url}${r.resourceType ? ` (${r.resourceType})` : ''}`);
  }
  const shown = lines.slice(0, maxLines);
  if (lines.length > shown.length) shown.push(`  … ${String(lines.length - shown.length)} more`);
  const head = opts.heading ?? 'Diagnostics';
  return [`${head}: ${d.summary}`, ...shown].join('\n');
}

/** A compact one-line note for the agent when a page-changing action surfaced problems. */
export function diagnosticsNote(d: BrowserDiagnostics): string {
  return formatBrowserDiagnostics(d, {
    heading: 'Frontend diagnostics after this action',
    maxLines: 8,
  });
}
