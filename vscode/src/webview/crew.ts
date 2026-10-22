/**
 * The crew view next to the conversation: helpers the agent started, each a small card wired to
 * the head agent. The browser cockpit lives in `browserCockpit.ts`.
 */
import { badge } from './modelPicker.js';
import { escapeHtml, formatUsd } from './render.js';

export interface Helper {
  id: number;
  kind: string;
  agent?: string;
  description: string;
  status: 'working' | 'done' | 'stopped';
  turns: number;
  usd: number;
  startedAt: number;
  finishedAt?: number;
}

const KIND_LABEL: Record<string, string> = {
  explore: 'Explorer',
  plan: 'Planner',
  review: 'Reviewer',
  general: 'Helper',
};

/**
 * Bento role styling per helper kind: the accent that tints the card's glow, the role eyebrow,
 * and the present-tense status word shown while it works (EXPLORING / PLANNING / AUDITING…).
 */
const KIND_ROLE: Record<string, { accent: string; role: string; doing: string }> = {
  explore: { accent: 'amber', role: 'EXPLORER', doing: 'EXPLORING' },
  plan: { accent: 'violet', role: 'PLANNER', doing: 'PLANNING' },
  review: { accent: 'green', role: 'REVIEWER', doing: 'AUDITING' },
  general: { accent: 'blue', role: 'HELPER', doing: 'WORKING' },
};

const roleOf = (h: Helper): { accent: string; role: string; doing: string } =>
  KIND_ROLE[h.kind] ?? { accent: 'blue', role: 'HELPER', doing: 'WORKING' };

function statusLineHtml(h: Helper): string {
  const word =
    h.status === 'working' ? roleOf(h).doing : h.status === 'done' ? 'REPORTED' : 'STOPPED';
  return `<div class="h-status"><span class="h-dot" aria-hidden="true"></span>${word}</div>`;
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}

function seconds(h: Helper): string {
  const end = h.finishedAt ?? Date.now();
  return `${String(Math.max(1, Math.round((end - h.startedAt) / 1_000)))}s`;
}

function statusHtml(h: Helper): string {
  if (h.status === 'working') return '<span class="spinner" aria-hidden="true"></span>';
  return h.status === 'done' ? '<span class="h-ok">✓</span>' : '<span class="h-warn">!</span>';
}

function footHtml(h: Helper): string {
  if (h.status === 'working') return `<span class="h-live">working · ${seconds(h)}</span>`;
  const word = h.status === 'done' ? '↩ reported' : 'stopped early';
  return `<span>${word} · ${String(h.turns)} turns · ${seconds(h)}${h.usd ? ` · ${formatUsd(h.usd)}` : ''}</span>`;
}

function cardHtml(h: Helper): string {
  const name = h.agent ?? KIND_LABEL[h.kind] ?? h.kind;
  const role = roleOf(h);
  return `<li class="helper ${h.status} accent-${role.accent}"><span class="wire" aria-hidden="true"></span><div class="h-card"><div class="h-top">${badge(name)}<span class="h-name">${escapeHtml(name)}</span><span class="h-role">${role.role}</span>${statusHtml(h)}</div>${statusLineHtml(h)}<div class="h-task">${escapeHtml(h.description)}</div><div class="h-foot">${footHtml(h)}</div></div></li>`;
}

export function drawCrew(helpers: readonly Helper[], logoSrc: string): void {
  const section = el('crew');
  section.hidden = helpers.length === 0;
  if (!helpers.length) return;
  const working = helpers.filter((h) => h.status === 'working').length;
  el('crew-count').textContent = working
    ? `${String(working)} working`
    : `${String(helpers.length)} reported`;
  el('crew-body').innerHTML =
    `<div class="head-agent"><img src="${logoSrc}" alt=""><span>omnexx</span></div><ul class="helpers">${helpers.map(cardHtml).join('')}</ul>`;
}

export function resetViews(): void {
  el('crew').hidden = true;
}
