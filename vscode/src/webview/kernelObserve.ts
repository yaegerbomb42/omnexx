/**
 * Observe-only Kernel disclosure: the adaptive kernel's live phase as one quiet
 * line, with the detail behind a collapsed disclosure. The `why` strings on the
 * snapshot are raw bm25 ranking debug ("bm25 match for …"), not user-facing
 * info, so they are never rendered — capability names only. The KV cache row is
 * gone: Live Stats already shows the same cache hit / saved numbers from the
 * same usage data. The Selective mount row only appears when it actually saves
 * tokens; with no catalog it would sit at 0 forever.
 */
import { escapeHtml, formatTokens } from './render.js';

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

export function kernelObserveHtml(k: KernelSnapshot | null | undefined): string {
  if (!k) return '';
  const phases = PHASES.map(
    (p) =>
      `<span class="ko-phase${p === k.phase ? ' on' : ''}"${p === k.phase ? ' aria-current="step"' : ''}>${p}</span>`,
  ).join('');
  const caps = k.active.length
    ? k.active
        .map(
          (a) =>
            `<li><span class="ko-kind ko-${kindOf(a.id)}">${kindOf(a.id)}</span><span class="ko-cap">${escapeHtml(shortId(a.id))}</span></li>`,
        )
        .join('')
    : '<li class="ko-empty">core tools only</li>';
  const saved = k.mountSavings
    ? Math.max(0, k.mountSavings.catalogTokens - k.mountSavings.mountedTokens)
    : 0;
  const mountRow =
    saved > 0
      ? `<div class="ko-row"><span class="ko-label">Selective mount</span><span class="ko-value">${escapeHtml(formatTokens(saved))} tok/turn saved</span></div>`
      : '';
  return `<details class="ko">
<summary class="ko-summary"><span class="chev" aria-hidden="true"></span><span class="ko-title">Kernel</span><span class="ko-phases">${phases}</span><span class="ko-meta">${escapeHtml(k.taskClass)} · tier ${String(k.tier)}</span></summary>
<ul class="ko-caps">${caps}</ul>
<div class="ko-row"><span class="ko-label">Cadence</span><span class="ko-value">${escapeHtml(CADENCE[k.cadence] ?? k.cadence)} <span class="ko-dim">(${escapeHtml(k.reason.replace(/_/g, ' '))})</span></span></div>
${mountRow}
</details>`;
}
