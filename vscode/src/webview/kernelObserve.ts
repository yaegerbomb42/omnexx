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

/** Observe-only System-1 (Jev) telemetry; mirrors `SystemOneObserveSnapshot` on the CLI side. */
export interface SystemOneSnapshot {
  backend: string;
  model: string;
  intent: { label: string; confidence: number } | null;
  guardrail: { checked: number; intercepted: number };
  patch: { checked: number; caught: number };
  triage: { runs: number; linesPruned: number; tokensSaved: number };
  speculative: { hits: number };
  earlyStop: { turnsSaved: number; tokensSaved: number };
  tokensSaved: number;
  latencyP50Ms: number;
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

/** The System-1 card: backend, last intent, gates passed/caught, and what it saved. No controls. */
export function systemOneObserveHtml(s: SystemOneSnapshot | null | undefined): string {
  if (!s) return '';
  const intent = s.intent
    ? `<span class="ko-pill">${escapeHtml(s.intent.label.replaceAll('_', ' '))} · ${String(Math.round(s.intent.confidence * 100))}%</span>`
    : '';
  const turns = s.earlyStop.turnsSaved + s.speculative.hits;
  return `<div class="ko-card ko-s1" role="status" aria-label="System-1">
<div class="ko-head"><span class="ko-title">System-1</span><span class="ko-meta">${escapeHtml(s.backend)} · p50 ${escapeHtml(s.latencyP50Ms.toFixed(1))}ms</span></div>
${intent ? `<div class="ko-pills">${intent}</div>` : ''}
<div class="ko-row"><span class="ko-label">Guardrails</span><span class="ko-value">${String(s.guardrail.checked)} checked · ${String(s.guardrail.intercepted)} intercepted</span></div>
<div class="ko-row"><span class="ko-label">Patch sanity</span><span class="ko-value">${String(s.patch.checked)} checked · ${String(s.patch.caught)} caught</span></div>
<div class="ko-row"><span class="ko-label">Saved</span><span class="ko-value">${escapeHtml(formatTokens(s.tokensSaved))} tok · ${String(turns)} turn${turns === 1 ? '' : 's'} <span class="ko-dim">(${escapeHtml(formatTokens(s.triage.linesPruned))} noise lines pruned)</span></span></div>
</div>`;
}

export function kernelObserveHtml(
  k: KernelSnapshot | null | undefined,
  u?: Usage | null,
  s1?: SystemOneSnapshot | null,
): string {
  const systemOne = systemOneObserveHtml(s1);
  if (!k) return systemOne;
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
</div>${systemOne}`;
}
