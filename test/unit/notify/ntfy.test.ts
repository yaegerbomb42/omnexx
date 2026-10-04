import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/load.js';
import { formatPush, NtfyNotifier, type NotifyPayload } from '../../../src/notify/ntfy.js';
import { Redactor } from '../../../src/security/redact.js';
import { mockServer } from '../../support/mock-http.js';
import { secretCorpus } from '../../support/secrets.js';

const payload: NotifyPayload = {
  kind: 'needs-human',
  runId: 'r_1',
  repo: 'app',
  status: 'needs-human',
  taskTitle: 'Fix login',
  done: 3,
  total: 7,
  parked: 2,
  commits: 4,
  usd: 1.234,
  budgetUsd: 50,
  hint: 'all runnable tasks parked',
};

describe('ntfy', () => {
  it('pushes only allow-listed fields, redacted, with auth from token_env', async () => {
    const srv = await mockServer((_r, res) => {
      res.writeHead(200).end('{}');
    });
    const results: string[] = [];
    const cfg = defaultConfig({
      notify: { ntfy: { server: srv.url, topic: 'omnexx-test', token_env: 'NTFY_TOKEN' } },
    }).notify.ntfy;
    if (!cfg) throw new Error('cfg');
    const n = new NtfyNotifier(
      cfg,
      { NTFY_TOKEN: 'tok-123456789' },
      new Redactor(),
      fetch,
      (ok, d) => results.push(`${ok}:${d}`),
    );
    await n.notify({ ...payload, taskTitle: `leak ${secretCorpus().github}` });
    await n.notify({ ...payload, kind: 'stopped' }); // not in default events
    expect(srv.requests).toHaveLength(1);
    const r = srv.requests[0];
    expect(r?.url).toBe('/omnexx-test');
    expect(r?.headers.title).toBe('Omnexx needs you');
    expect(r?.headers.authorization).toBe('Bearer tok-123456789');
    expect(r?.body).toBe(
      'app · r_1 · needs-human\n3/7 tasks · 2 parked · 4 commits · $1.23 of $50\nTask: leak [REDACTED]\nall runnable tasks parked',
    );
    expect(results).toEqual(['true:needs-human: HTTP 200']);
  });

  it('a failing server is reported, never thrown', async () => {
    const cfg = defaultConfig({
      notify: { ntfy: { server: 'http://127.0.0.1:9', topic: 't', timeout_ms: 500 } },
    }).notify.ntfy;
    if (!cfg) throw new Error('cfg');
    const results: boolean[] = [];
    await new NtfyNotifier(cfg, {}, new Redactor(), fetch, (ok) => results.push(ok)).notify(
      payload,
    );
    expect(results).toEqual([false]);
  });

  it('formatPush with minimal fields', () => {
    expect(formatPush({ kind: 'started', runId: 'r', repo: 'x' })).toEqual({
      title: 'Omnexx run started',
      body: 'x · r',
      priority: '2',
      tags: 'omnexx,started',
    });
  });
});
