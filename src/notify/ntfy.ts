import type { OmnexxConfig } from '../config/schema.js';
import type { Redactor } from '../security/redact.js';

export type NotifyKind =
  'started' | 'finished' | 'needs-human' | 'budget' | 'crash' | 'outage' | 'stopped';

/**
 * The only fields a push may carry (plan §3.12): ids, the repo's name, a task title, counts and
 * dollar amounts. Never code, diffs, paths outside the repo name, logs or secrets.
 */
export interface NotifyPayload {
  kind: NotifyKind;
  /** A link to open (the run's PR). */
  url?: string;
  runId: string;
  repo: string;
  status?: string;
  taskTitle?: string;
  done?: number;
  total?: number;
  parked?: number;
  commits?: number;
  usd?: number;
  budgetUsd?: number;
  hint?: string;
}

const TITLES: Record<NotifyKind, string> = {
  started: 'Omnexx run started',
  finished: 'Omnexx run finished',
  'needs-human': 'Omnexx needs you',
  budget: 'Omnexx budget',
  crash: 'Omnexx resumed after a crash',
  outage: 'Omnexx: API outage',
  stopped: 'Omnexx run stopped',
};
const PRIORITY: Record<NotifyKind, string> = {
  started: '2',
  finished: '3',
  'needs-human': '4',
  budget: '4',
  crash: '3',
  outage: '4',
  stopped: '3',
};

export function formatPush(p: NotifyPayload): {
  title: string;
  body: string;
  priority: string;
  tags: string;
} {
  const lines = [`${p.repo} · ${p.runId}${p.status ? ` · ${p.status}` : ''}`];
  const counts = [
    p.done !== undefined && p.total !== undefined ? `${p.done}/${p.total} tasks` : undefined,
    p.parked ? `${p.parked} parked` : undefined,
    p.commits !== undefined ? `${p.commits} commits` : undefined,
    p.usd !== undefined
      ? `$${p.usd.toFixed(2)}${p.budgetUsd !== undefined ? ` of $${p.budgetUsd}` : ''}`
      : undefined,
  ].filter(Boolean);
  if (counts.length) lines.push(counts.join(' · '));
  if (p.taskTitle) lines.push(`Task: ${p.taskTitle.slice(0, 120)}`);
  if (p.hint) lines.push(p.hint.slice(0, 160));
  if (p.url) lines.push(p.url);
  return {
    title: TITLES[p.kind],
    body: lines.join('\n'),
    priority: PRIORITY[p.kind],
    tags: `omnexx,${p.kind}`,
  };
}

export interface Notifier {
  notify(p: NotifyPayload): Promise<void>;
}

export class NtfyNotifier implements Notifier {
  constructor(
    private readonly cfg: NonNullable<OmnexxConfig['notify']['ntfy']>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly redactor: Redactor,
    private readonly fetchFn: typeof fetch,
    private readonly onResult: (ok: boolean, detail: string) => void,
  ) {}

  async notify(p: NotifyPayload): Promise<void> {
    const kindAllowed = (this.cfg.events as readonly string[]).includes(
      p.kind === 'budget' ? 'budget' : p.kind,
    );
    if (!kindAllowed) return;
    const msg = formatPush(p);
    const token = this.cfg.token_env ? this.env[this.cfg.token_env] : undefined;
    try {
      const res = await this.fetchFn(`${this.cfg.server.replace(/\/+$/, '')}/${this.cfg.topic}`, {
        method: 'POST',
        headers: {
          Title: this.redactor.text(msg.title),
          Priority: msg.priority,
          Tags: msg.tags,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: this.redactor.text(msg.body),
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      });
      this.onResult(res.ok, `${p.kind}: HTTP ${res.status}`);
    } catch (err) {
      this.onResult(false, `${p.kind}: ${(err as Error).message}`);
    }
  }
}

export const nullNotifier: Notifier = { notify: () => Promise.resolve() };
