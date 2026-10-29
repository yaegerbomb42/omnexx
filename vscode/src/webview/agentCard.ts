/**
 * The "Agent" card: the five settings omnexx manages itself by (effort per task, context
 * prominent; effort per turn, time and max tokens below), with a live one-line meaning per level.
 * Shown on the settings page and, while "always ask" is on, once at the top of a new panel.
 * Data comes from `omnexx chat-server` (`agentSettings`), saved with `setAgentSettings`.
 */
import { escapeHtml } from './render.js';
import { flashSaved } from './savedMark.js';
import {
  meaning,
  position,
  steps,
  withPosition,
  type AgentLevels,
  type AgentMeta,
  type SliderId,
  SLIDERS,
  type Slider,
} from './agentCardModel.js';

type Post = (msg: Record<string, unknown>) => void;

let levels: AgentLevels | undefined;
let meta: AgentMeta | undefined;
let askOnStart = true;
let offered = false;
let status = '';

function sliderHtml(s: Slider, l: AgentLevels, m: AgentMeta): string {
  const pos = position(s.id, l, m);
  const pct = Math.round((pos / steps(s.id, m)) * 100);
  return `<div class="agent-row${s.prominent ? ' prominent' : ''}">
  <div class="agent-row-head"><label for="agent-${s.id}">${s.name}</label>
  <span class="agent-meaning" data-agent-meaning="${s.id}">${escapeHtml(meaning(s.id, l, m))}</span></div>
  <input id="agent-${s.id}" type="range" min="1" max="${String(steps(s.id, m))}" step="1" value="${String(pos)}" style="--p:${String(pct)}%" data-agent-slider="${s.id}" aria-valuetext="${escapeHtml(meaning(s.id, l, m))}">
  <span class="agent-hint">${escapeHtml(s.hint)}</span>
</div>`;
}

function cardHtml(withSave: boolean): string {
  if (!levels || !meta) return '<p class="hint">Loading agent settings…</p>';
  const l = levels;
  const m = meta;
  const footer = withSave
    ? `<label class="agent-ask"><input type="checkbox" data-agent-ask ${askOnStart ? 'checked' : ''}> Always ask when the panel opens</label>
<div class="row-end"><span class="status" role="status">${escapeHtml(status)}</span><button class="primary" data-agent-save>Save</button></div>`
    : '';
  return `<div class="agent-card">
${SLIDERS.map((s) => sliderHtml(s, l, m)).join('\n')}
${footer}
</div>`;
}

/** The card's inner HTML (settings page). */
export function html(): string {
  return cardHtml(true);
}

/** The launch offer: the same card with "keep, don't ask again" and "ask next time". */
function startHtml(): string {
  return `<div class="agent-start-head"><strong>Agent settings for this session</strong><button class="ghost" data-agent-dismiss aria-label="Close">×</button></div>
${cardHtml(false)}
<div class="row-end">
  <button class="secondary" data-agent-keep="ask">Use, ask next time</button>
  <button class="primary" data-agent-keep="keep">Keep, don't ask again</button>
</div>`;
}

function redraw(): void {
  const box = document.getElementById('agent-box');
  if (box) box.innerHTML = html();
  const start = document.getElementById('agent-start');
  if (start && !start.hidden) start.innerHTML = startHtml();
}

export function request(post: Post): void {
  post({ type: 'agentSettings' });
}

function isEditingCard(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement &&
    Boolean(active.closest('.agent-card, #agent-start, .agent-start'))
  );
}

/** Messages for the card; true when handled. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'agentSettings') return false;
  levels = m.levels as AgentLevels;
  meta = m.meta as AgentMeta;
  askOnStart = m.askOnStart !== false;
  const start = document.getElementById('agent-start');
  if (start && !offered && askOnStart) {
    offered = true;
    start.hidden = false;
  }
  // A full innerHTML redraw while a slider or checkbox is focused resets the control.
  if (isEditingCard()) return true;
  redraw();
  return true;
}

function save(post: Post, ask: boolean): void {
  if (!levels) return;
  askOnStart = ask;
  post({ type: 'setAgentSettings', levels, askOnStart: ask });
  flashSaved('agent');
}

function closeStart(): void {
  const start = document.getElementById('agent-start');
  if (start) start.hidden = true;
}

/** Live labels while dragging; save and the launch offer's buttons. */
export function wire(post: Post): void {
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !levels || !meta) return;
    const id = t.dataset.agentSlider as SliderId | undefined;
    if (!id) return;
    levels = withPosition(id, Number(t.value), levels, meta);
    t.style.setProperty('--p', `${String(Math.round((Number(t.value) / steps(id, meta)) * 100))}%`);
    t.setAttribute('aria-valuetext', meaning(id, levels, meta));
    status = '';
    // Update every copy of this slider's label (settings page and launch offer).
    const text = meaning(id, levels, meta);
    document.querySelectorAll<HTMLElement>(`[data-agent-meaning="${id}"]`).forEach((n) => {
      n.textContent = text;
    });
  });
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-agent-save]')) {
      const box = t.closest('.agent-card');
      const ask = box?.querySelector<HTMLInputElement>('[data-agent-ask]')?.checked ?? askOnStart;
      save(post, ask);
      redraw();
    } else if (t.closest('[data-agent-dismiss]')) closeStart();
    else {
      const keep = t.closest<HTMLElement>('[data-agent-keep]')?.dataset.agentKeep;
      if (!keep) return;
      save(post, keep === 'ask');
      closeStart();
    }
  });
}
