import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { MailBackend, OutgoingMail } from '../../../src/integrations/email/backend.js';
import {
  appPasswordHelp,
  providerFor,
  resolveHosts,
} from '../../../src/integrations/email/presets.js';
import { createEmailServer } from '../../../src/integrations/email/server.js';

class FakeMail implements MailBackend {
  drafts: OutgoingMail[] = [];
  sent: OutgoingMail[] = [];
  folders = () => Promise.resolve([{ path: 'INBOX' }, { path: '[Gmail]/Drafts', role: 'drafts' }]);
  search = () =>
    Promise.resolve([
      {
        uid: 7,
        date: '2026-10-08T10:00:00.000Z',
        from: 'Sam <sam@x>',
        subject: 'Lunch?',
        unread: true,
      },
    ]);
  read = (_f: string, uid: number) =>
    Promise.resolve(
      uid === 7
        ? {
            uid,
            date: 'd',
            from: 'Sam',
            to: 'me',
            cc: '',
            subject: 'Lunch?',
            unread: true,
            text: 'Noon?',
            attachments: [],
          }
        : undefined,
    );
  draft = (m: OutgoingMail) => {
    this.drafts.push(m);
    return Promise.resolve('[Gmail]/Drafts');
  };
  send = (m: OutgoingMail) => {
    this.sent.push(m);
    return Promise.resolve();
  };
  verify = () =>
    Promise.reject(Object.assign(new Error('Command failed'), { authenticationFailed: true }));
}

async function connect(backend: MailBackend, allowSend: boolean) {
  const server = createEmailServer(backend, { address: 'me@gmail.com', allowSend });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0]?.text ?? '', isError: r.isError === true };
  };
  return { client, call };
}

describe('email MCP tools', () => {
  it('offers read, search and draft tools, and email_send only when sending is allowed', async () => {
    const off = await connect(new FakeMail(), false);
    const on = await connect(new FakeMail(), true);
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    expect(await names(off.client)).toEqual([
      'email_draft',
      'email_folders',
      'email_read',
      'email_search',
    ]);
    expect(await names(on.client)).toContain('email_send');
  });

  it('formats search results and reads a message', async () => {
    const { call } = await connect(new FakeMail(), false);
    expect((await call('email_search', { text: 'lunch' })).text).toBe(
      'uid 7 · 2026-10-08T10:00 · Sam <sam@x> · Lunch? · unread',
    );
    expect((await call('email_read', { uid: 7 })).text).toMatch(
      /^From: Sam\nTo: me\nDate: d\nSubject: Lunch\?\n\nNoon\?$/,
    );
    expect((await call('email_read', { uid: 9 })).text).toBe('no message with uid 9 in INBOX');
  });

  it('drafts instead of sending, and sends only through email_send', async () => {
    const mail = new FakeMail();
    const { call } = await connect(mail, true);
    expect((await call('email_draft', { to: 'sam@x', subject: 'Re', text: 'Yes' })).text).toBe(
      'saved a draft to sam@x in [Gmail]/Drafts',
    );
    await call('email_send', { to: 'sam@x', subject: 'Re', text: 'Yes', in_reply_to: '<1@x>' });
    expect(mail.drafts).toHaveLength(1);
    expect(mail.sent).toEqual([{ to: 'sam@x', subject: 'Re', text: 'Yes', inReplyTo: '<1@x>' }]);
  });

  it('turns a mail error into a tool error the agent can read', async () => {
    const mail = new FakeMail();
    mail.search = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    const { call } = await connect(mail, false);
    const r = await call('email_search', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not reach the mail server/);
  });
});

describe('mail provider presets', () => {
  it('knows the big providers by domain', () => {
    expect(resolveHosts('a@gmail.com').imap.host).toBe('imap.gmail.com');
    expect(resolveHosts('a@hotmail.com').smtp).toEqual({
      host: 'smtp-mail.outlook.com',
      port: 587,
      secure: false,
    });
    expect(providerFor('A@ICLOUD.COM')?.name).toBe('iCloud');
  });

  it('takes host overrides and defaults custom domains to Google Workspace', () => {
    expect(resolveHosts('me@acme.dev').imap.host).toBe('imap.gmail.com');
    expect(
      resolveHosts('me@acme.dev', { imapHost: 'mail.acme.dev', smtpPort: '465' }),
    ).toMatchObject({
      imap: { host: 'mail.acme.dev', port: 993 },
      smtp: { port: 465, secure: true },
    });
  });

  it('points at the right app-password page', () => {
    expect(appPasswordHelp('x@gmail.com')).toContain('myaccount.google.com/apppasswords');
    expect(appPasswordHelp('x@yahoo.com')).toContain('Yahoo');
    expect(appPasswordHelp('x@acme.dev')).toContain('Google Workspace');
  });
});
