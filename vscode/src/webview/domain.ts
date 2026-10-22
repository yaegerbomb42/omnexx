/**
 * The Work Domain selector: the chat's [execution] domain (swe / general) as a two-segment
 * neutral pill under the posture pill in the chat header, and again in Settings → Agent.
 *
 * A separate axis from the execution posture (efficient / normal / extreme): the domain
 * says what kind of work a run does — "swe" is software engineering (AST tools, test gates),
 * "general" is artifact work (documents, data, research; checks instead of test suites).
 *
 * Like the posture, the value lives in config, not in the chat server: the extension host
 * reads the effective value (OMNEXX_EXECUTION_DOMAIN, then the project's omnexx.toml, then
 * the user config.toml) and answers `workDomain`; a pick posts `setWorkDomain`, the host
 * writes `domain` into the user config's [execution] table, and runs pick it up at the
 * next cycle boundary. When a stronger layer overrides the user value, the host reports
 * that source and the selector shows it, with a note.
 */
import { escapeHtml } from './render.js';

type Post = (msg: Record<string, unknown>) => void;

export type WorkDomain = 'swe' | 'general';
export type DomainSource = 'env' | 'project' | 'user' | 'default';

export interface DomainMeta {
  id: WorkDomain;
  icon: string;
  name: string;
  caption: string;
}

/** The two domains, with the one-line caption each shows while active. */
export const DOMAINS: readonly DomainMeta[] = [
  {
    id: 'swe',
    icon: '🛠',
    name: 'SWE',
    caption: 'Software engineering: code tools, test gates and git rollbacks.',
  },
  {
    id: 'general',
    icon: '🗂',
    name: 'General',
    caption: 'Documents, data and research: artifact checks instead of test suites.',
  },
];

export const isWorkDomain = (v: unknown): v is WorkDomain => v === 'swe' || v === 'general';

export const metaFor = (domain: WorkDomain): DomainMeta =>
  DOMAINS.find((d) => d.id === domain) ?? (DOMAINS[0] as DomainMeta);

/** Why the selector may not reflect a pick: a stronger config layer is in charge. */
export function sourceNote(source: DomainSource): string {
  if (source === 'env')
    return 'Set by the OMNEXX_EXECUTION_DOMAIN environment variable, which wins over config files.';
  if (source === 'project')
    return "Set in this project's omnexx.toml, which wins over your user settings; picks save to your user config instead.";
  return 'Saved to your config.toml; a running task picks it up at its next cycle.';
}

let current: WorkDomain = 'swe';
let source: DomainSource = 'default';

/** The selector: a label, the two segments, the active domain's caption, any override note. */
export function pillHtml(): string {
  const meta = metaFor(current);
  const buttons = DOMAINS.map(
    (d) =>
      `<button data-domain="${d.id}" aria-pressed="${String(d.id === current)}" title="${escapeHtml(d.caption)}"><span class="posture-ico" aria-hidden="true">${d.icon}</span>${d.name}</button>`,
  ).join('');
  return `<div class="domain-head"><span class="domain-label">Work mode</span><span class="domain-hint">what kind of work runs do</span></div>
<div class="posture-pill domain-pill" role="group" aria-label="Work mode">${buttons}</div>
<p class="posture-caption">${escapeHtml(meta.caption)}</p>
<p class="posture-note">${escapeHtml(sourceNote(source))}</p>`;
}

/** The Settings card wrapping the selector (the chat header uses the bare selector). */
export function cardHtml(): string {
  return `<div class="posture-card">
<div class="posture-title">Work Mode</div>
<div data-domain-slot>${pillHtml()}</div>
</div>`;
}

/** Fill every selector slot on the page (chat header, settings card) with the current state. */
export function render(): void {
  document.querySelectorAll<HTMLElement>('[data-domain-slot]').forEach((slot) => {
    slot.innerHTML = pillHtml();
  });
}

/** Ask the extension host for the effective domain. */
export function request(post: Post): void {
  post({ type: 'workDomain' });
}

/** The host's answer: the effective domain and which config layer set it. */
export function onMessage(m: { type: string } & Record<string, unknown>): boolean {
  if (m.type !== 'workDomain') return false;
  if (isWorkDomain(m.domain)) current = m.domain;
  if (m.source === 'env' || m.source === 'project' || m.source === 'user' || m.source === 'default')
    source = m.source;
  render();
  return true;
}

/** Segment clicks (delegated: the selector is re-rendered in place, in two places at once). */
export function wire(post: Post): void {
  render();
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const domain = t?.closest<HTMLElement>('[data-domain]')?.dataset.domain;
    if (!isWorkDomain(domain) || domain === current) return;
    current = domain;
    render();
    post({ type: 'setWorkDomain', domain });
  });
}
