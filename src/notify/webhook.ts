import type { OmnexxConfig } from '../config/schema.js';
import type { Redactor } from '../security/redact.js';
import { formatPush, type Notifier, type NotifyPayload } from './ntfy.js';

/**
 * Posts to a Slack- or Discord-compatible incoming webhook: one JSON body carries `text` (Slack)
 * and `content` (Discord). Never throws: a failed notification must not affect the run.
 */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly cfg: NonNullable<OmnexxConfig['notify']['webhook']>,
    private readonly env: NodeJS.ProcessEnv,
    private readonly redactor: Redactor,
    private readonly fetchFn: typeof fetch,
    private readonly onResult: (ok: boolean, detail: string) => void,
  ) {}

  async notify(p: NotifyPayload): Promise<void> {
    if (!this.cfg.events.includes(p.kind)) return;
    const url = this.env[this.cfg.url_env];
    if (!url) {
      this.onResult(false, `webhook: ${this.cfg.url_env} is not set`);
      return;
    }
    const f = formatPush(p);
    const text = this.redactor.text(`*${f.title}*\n${f.body}`);
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      });
      this.onResult(res.ok, `webhook ${p.kind}: HTTP ${res.status}`);
    } catch (err) {
      this.onResult(false, `webhook ${p.kind}: ${(err as Error).message}`);
    }
  }
}

/** Every configured channel gets every notification. */
export function allOf(notifiers: readonly Notifier[]): Notifier {
  return {
    async notify(p) {
      await Promise.all(notifiers.map((n) => n.notify(p)));
    },
  };
}
