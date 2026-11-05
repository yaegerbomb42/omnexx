/**
 * Observe-only Kernel card: the adaptive kernel's live phase, active capabilities (with a
 * one-line why), cadence/VoI decision and savings. No toggles: it only reflects the latest
 * `kernel` snapshot on the chat state frame, and stays hidden until the kernel allocates.
 */
import {
  cacheHitPercent,
  cacheSaved,
  escapeHtml,
  formatTokens,
  formatUsd,
  type Usage,
} from './render.js';

export interface KernelSnapshot {
  turn: number;
  phase: string;
  taskClass: string;
  tier: number;
  cadence: string;
  reason: string;
  epoch: number;
  rank: string;
  active: { id: string; why: string }[];
  mountSavings: { catalogTokens: number; mountedTokens: number } | null;
  priors: { arm: string; pulls: number; mean: number }[];
}

const PHASES = ['orient', 'plan', 'act', 'verify', 'synthesize'] as const;

const CADENCE: Record<string, string> = {
  stay_sticky: 'sticky · prefix cached',
  reselect_append_only: 'reselected · append-only',
  rebake_epoch: 're-baked tools',
  compact_gc: 'compacted context',
  escalate_mode: 'escalated',
  verify_now: 'verify now',
};

const kindOf = (id: string): string =>
  id.includes(':skill:')
    ? 'skill'
    : id.includes(':mcp:') || id.startsWith('registry:')
      ? 'mcp'
      : 'tool';
const shortId = (id: string): string => id.replace(/^(local|registry):(mcp|tool|skill):/, '');

export function kernelObserveHtml(k: KernelSnapshot | null | undefined, u?: Usage | null): string {
  if (!k) return '';
  const phases = PHASES.map(
    (p) =>
      `<span class="ko-phase${p === k.phase ? ' on' : ''}"${p === k.phase ? ' aria-current="step"' : ''}>${p}</span>`,
  ).join('');
  const caps = k.active.length
    ? k.active
        .map(
          (a) =>
            `<li><span class="ko-kind ko-${kindOf(a.id)}">${kindOf(a.id)}</span><span class="ko-cap">${escapeHtml(shortId(a.id))}</span><span class="ko-why">${escapeHtml(a.why)}</span></li>`,
        )
        .join('')
    : '<li class="ko-empty">core tools only</li>';
  const saved = k.mountSavings
    ? Math.max(0, k.mountSavings.catalogTokens - k.mountSavings.mountedTokens)
    : 0;
  const cache = u
    ? `${String(cacheHitPercent(u))}% hit · ${formatUsd(cacheSaved(u).usd)} saved`
    : '–';
  return `<div class="ko-card" role="status" aria-label="Kernel">
<div class="ko-head"><span class="ko-title">Kernel</span><span class="ko-meta">${escapeHtml(k.taskClass)} · tier ${String(k.tier)} · ${escapeHtml(k.rank)}</span></div>
<div class="ko-phases">${phases}</div>
<ul class="ko-caps">${caps}</ul>
<div class="ko-row"><span class="ko-label">Cadence</span><span class="ko-value">${escapeHtml(CADENCE[k.cadence] ?? k.cadence)} <span class="ko-dim">(${escapeHtml(k.reason.replace(/_/g, ' '))})</span></span></div>
<div class="ko-row"><span class="ko-label">Selective mount</span><span class="ko-value">${escapeHtml(formatTokens(saved))} tok/turn saved</span></div>
<div class="ko-row"><span class="ko-label">KV cache</span><span class="ko-value">${escapeHtml(cache)}</span></div>
</div>`;
}
