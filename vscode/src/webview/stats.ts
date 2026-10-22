/**
 * Live session stats, drawn from the chat state the webview already receives on every frame:
 * the Live Stats card and Token Budget bar in Settings → Agent, and the telemetry strip over
 * the crew cards. Every number here is real session data — cache hits and token counts from
 * the usage totals, the success rate from tool calls vs tool errors, the budget from the
 * context meter. Anything the state doesn't carry (latency, a token sparkline) is left out
 * rather than invented.
 */
import {
  cacheHitPercent,
  contextPercent,
  escapeHtml,
  formatTokens,
  formatUsd,
  type Usage,
} from './render.js';

export interface StatsInput {
  usage: (Usage & { startedAt: number | null }) | null;
  context: { used: number; limit: number } | null;
}

let last: StatsInput = { usage: null, context: null };

/** Share of tool calls that did not error, or null before the first call. */
export function successRate(u: Usage | null): number | null {
  if (!u || u.toolCalls <= 0) return null;
  return Math.round((1 - u.toolErrors / u.toolCalls) * 100);
}

/** Average session throughput (tokens in + out per second), or null too early to say. */
export function tokensPerSecond(u: (Usage & { startedAt: number | null }) | null): number | null {
  if (!u?.startedAt) return null;
  const seconds = (Date.now() - u.startedAt) / 1_000;
  if (seconds < 5) return null;
  return Math.round((u.tokens.input + u.tokens.output) / seconds);
}

const row = (label: string, value: string): string =>
  `<div class="ls-row"><span class="ls-label">${escapeHtml(label)}</span><span class="ls-value">${escapeHtml(value)}</span></div>`;

/** The Live Stats card: cache hit, success rate, token usage against the context limit. */
export function liveStatsHtml(s: StatsInput = last): string {
  const u = s.usage;
  const rows: string[] = [];
  if (u) rows.push(row('Cache Hit', `${String(cacheHitPercent(u))}%`));
  const rate = successRate(u);
  if (rate !== null) rows.push(row('Success Rate', `${String(rate)}%`));
  if (s.context && s.context.limit > 0) {
    const pct = contextPercent(s.context);
    rows.push(
      `<div class="ls-row"><span class="ls-label">Token Usage</span><span class="ls-value">${escapeHtml(formatTokens(s.context.used))} / ${escapeHtml(formatTokens(s.context.limit))}</span></div>
<div class="ls-bar"><span style="width:${String(pct)}%"></span></div>`,
    );
  } else if (u) {
    rows.push(row('Token Usage', formatTokens(u.tokens.input + u.tokens.output)));
  }
  const body = rows.length
    ? rows.join('')
    : '<p class="hint">Stats appear once this chat has run.</p>';
  return `<div class="live-stats">
<div class="ls-head"><span class="ls-title">Live Stats</span><span class="ls-live"><span class="ls-dot" aria-hidden="true"></span>session</span></div>
${body}
</div>`;
}

/** The Token Budget bar: how much of the context window this chat has filled. */
export function tokenBudgetHtml(s: StatsInput = last): string {
  const pct = contextPercent(s.context);
  const sub = s.context
    ? `${formatTokens(s.context.used)} / ${formatTokens(s.context.limit)} tokens of context`
    : 'No context measured yet';
  return `<div class="budget">
<div class="budget-row"><span class="budget-label">Token Budget</span><span class="budget-pct">${s.context ? `${String(pct)}%` : '—'}</span></div>
<div class="budget-track"><span class="budget-fill${pct > 85 ? ' hot' : ''}" style="width:${String(pct)}%"></span></div>
<div class="budget-sub">${escapeHtml(sub)}</div>
</div>`;
}

/** The cockpit telemetry strip over the crew cards; empty until the session has usage. */
export function telemetryHtml(s: StatsInput = last): string {
  const u = s.usage;
  if (!u) return '';
  const total = u.tokens.input + u.tokens.output;
  if (total <= 0) return '';
  const tps = tokensPerSecond(u);
  const cell = (label: string, value: string): string =>
    `<span class="t-cell"><span class="t-label">${escapeHtml(label)}</span><span class="t-value">${escapeHtml(value)}</span></span>`;
  return [
    cell('Tokens', formatTokens(total)),
    tps !== null ? cell('Tokens/sec', `${formatTokens(tps)}/s avg`) : '',
    cell('Est. cost', formatUsd(u.usd)),
    cell('Cache hit', `${String(cacheHitPercent(u))}%`),
  ].join('');
}

function paint(id: string, html: string): void {
  const node = document.getElementById(id);
  if (node && node.innerHTML !== html) node.innerHTML = html;
}

/** Re-draw every stats surface from the last snapshot (Settings redraws its DOM wholesale). */
export function refresh(): void {
  paint('token-budget', tokenBudgetHtml());
  paint('live-stats', liveStatsHtml());
  const strip = document.getElementById('crew-telemetry');
  if (strip) {
    const html = telemetryHtml();
    strip.innerHTML = html;
    strip.hidden = html === '';
  }
}

/** A new chat state frame: remember it and refresh whichever surfaces are on the page. */
export function update(s: StatsInput): void {
  last = { usage: s.usage, context: s.context };
  refresh();
}
