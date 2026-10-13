/**
 * Two live views next to the conversation: the crew (helpers the agent started, each a small
 * card wired to the head agent) and the agent's browser (the latest screenshot after a
 * page-changing action).
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

export interface BrowserFrameMsg {
  seq: number;
  mime: string;
  url: string;
  action: string;
  data: string;
}

const KIND_LABEL: Record<string, string> = {
  explore: 'Explorer',
  plan: 'Planner',
  review: 'Reviewer',
  general: 'Helper',
};

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
  return `<li class="helper ${h.status}"><span class="wire" aria-hidden="true"></span><div class="h-card"><div class="h-top">${badge(name)}<span class="h-name">${escapeHtml(name)}</span>${statusHtml(h)}</div><div class="h-task">${escapeHtml(h.description)}</div><div class="h-foot">${footHtml(h)}</div></div></li>`;
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

let lastSeq = 0;

export function drawBrowser(f: BrowserFrameMsg): void {
  if (f.seq <= lastSeq) return;
  lastSeq = f.seq;
  const section = el('browser');
  section.hidden = false;
  el('b-url').textContent = f.url || 'about:blank';
  el('b-action').textContent = f.action;
  const img = el('b-img');
  if (img instanceof HTMLImageElement) img.src = `data:${f.mime};base64,${f.data}`;
}

export function resetViews(): void {
  lastSeq = 0;
  el('crew').hidden = true;
  el('browser').hidden = true;
}

export function wire(): void {
  // Click the screenshot to see it larger; click again to shrink it.
  el('b-img').addEventListener('click', () => {
    el('browser').classList.toggle('big');
  });
}
