import type { AddressInfo, Server } from 'node:net';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { ImapMailBackend, type MailAccount } from '../../src/integrations/email/backend.js';
import { friendlyMailError } from '../../src/integrations/email/server.js';

const RAW = (subject: string, from: string, body: string) =>
  `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: Thu, 08 Oct 2026 10:00:00 +0000\r\nMessage-ID: <${subject.replace(/\W/g, '')}@x>\r\n\r\n${body}`;

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function listen(server: Server | SMTPServer): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const net = 'server' in server ? (server as unknown as { server: Server }).server : server;
  return (net.address() as AddressInfo).port;
}

async function imapServer(): Promise<number> {
  const server = hoodiecrow({
    plugins: ['SPECIAL-USE'],
    users: { 'me@example.com': { password: 'apppass' } },
    storage: {
      INBOX: {
        messages: [
          { raw: RAW('Invoice 42', 'Billing <billing@acme.test>', 'Your invoice is attached.') },
          {
            raw: RAW('Lunch?', 'Sam <sam@friends.test>', 'Free at noon on Friday?'),
            flags: ['\\Seen'],
          },
        ],
      },
      '': { separator: '/', folders: { Drafts: { 'special-use': '\\Drafts' }, Sent: {} } },
    },
  });
  const port = await listen(server);
  closers.push(
    () =>
      new Promise((r) => {
        server.close(() => {
          r();
        });
      }),
  );
  return port;
}

const account = (imapPort: number, smtpPort = 1, password = 'apppass'): MailAccount => ({
  address: 'me@example.com',
  password,
  hosts: {
    imap: { host: '127.0.0.1', port: imapPort, secure: false },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
  },
});

describe('IMAP mail backend (against an in-memory IMAP server)', () => {
  it('lists folders with their roles and searches newest first', async () => {
    const mail = new ImapMailBackend(account(await imapServer()));

    const folders = await mail.folders();
    const hits = await mail.search({ folder: 'INBOX', limit: 10 });

    expect(folders).toContainEqual({ path: 'Drafts', role: 'drafts' });
    expect(hits.map((h) => h.subject)).toEqual(['Lunch?', 'Invoice 42']);
    expect(hits.find((h) => h.subject === 'Invoice 42')?.unread).toBe(true);
    expect(hits.find((h) => h.subject === 'Lunch?')?.from).toBe('Sam <sam@friends.test>');
  });

  it('filters by sender, words and unread', async () => {
    const mail = new ImapMailBackend(account(await imapServer()));
    expect(
      (await mail.search({ folder: 'INBOX', from: 'acme', limit: 10 })).map((h) => h.subject),
    ).toEqual(['Invoice 42']);
    expect(
      (await mail.search({ folder: 'INBOX', text: 'noon', limit: 10 })).map((h) => h.subject),
    ).toEqual(['Lunch?']);
    expect((await mail.search({ folder: 'INBOX', unreadOnly: true, limit: 10 })).length).toBe(1);
  });

  it('reads a message body and saves a draft into the Drafts folder', async () => {
    const mail = new ImapMailBackend(account(await imapServer()));
    const [first] = await mail.search({ folder: 'INBOX', subject: 'Invoice', limit: 1 });

    const msg = await mail.read('INBOX', first?.uid ?? 0);
    const where = await mail.draft({
      to: 'billing@acme.test',
      subject: 'Re: Invoice 42',
      text: 'Paid, thanks.',
    });

    expect(msg?.text).toBe('Your invoice is attached.');
    expect(msg?.to).toContain('me@example.com');
    expect(where).toBe('Drafts');
    const drafts = await mail.search({ folder: 'Drafts', limit: 5 });
    expect(drafts.map((d) => d.subject)).toEqual(['Re: Invoice 42']);
  });

  it('a wrong password is explained as an app-password problem', async () => {
    const mail = new ImapMailBackend(account(await imapServer(), 1, 'wrong'));
    const err = await mail.verify().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(friendlyMailError(err, 'me@gmail.com')).toMatch(
      /app password.*myaccount\.google\.com\/apppasswords/,
    );
  });

  it('sends through SMTP with the account login', async () => {
    const got: { from: string; to: string[]; user: string }[] = [];
    const smtp = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth: (auth, _s, cb) => {
        if (auth.password === 'apppass') cb(null, { user: auth.username });
        else cb(new Error('bad'));
      },
      onData: (stream, session, cb) => {
        stream.resume();
        stream.on('end', () => {
          got.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            user: String(session.user),
          });
          cb();
        });
      },
    });
    const smtpPort = await listen(smtp);
    closers.push(
      () =>
        new Promise((r) => {
          smtp.close(() => {
            r();
          });
        }),
    );
    const mail = new ImapMailBackend(account(await imapServer(), smtpPort));

    await mail.send({ to: 'sam@friends.test', subject: 'Friday', text: 'Noon works.' });

    expect(got).toEqual([
      { from: 'me@example.com', to: ['sam@friends.test'], user: 'me@example.com' },
    ]);
  });
});
