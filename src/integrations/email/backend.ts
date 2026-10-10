import { ImapFlow, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { MailHosts } from './presets.js';

export interface MessageSummary {
  uid: number;
  date: string;
  from: string;
  subject: string;
  unread: boolean;
}

export interface Message extends MessageSummary {
  to: string;
  cc: string;
  text: string;
  attachments: string[];
}

export interface SearchQuery {
  folder: string;
  /** Words in the subject or body. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** ISO date: only mail on or after it. */
  since?: string;
  unreadOnly?: boolean;
  limit: number;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  cc?: string;
  inReplyTo?: string;
}

/** What the email tools need from a mailbox; the IMAP one is real, tests use a fake. */
export interface MailBackend {
  folders(): Promise<{ path: string; role?: string }[]>;
  search(q: SearchQuery): Promise<MessageSummary[]>;
  read(folder: string, uid: number): Promise<Message | undefined>;
  /** Save to the Drafts folder; returns its path. */
  draft(mail: OutgoingMail): Promise<string>;
  send(mail: OutgoingMail): Promise<void>;
  /** Log in and out, to check the address and password. */
  verify(): Promise<void>;
}

export interface MailAccount {
  address: string;
  password: string;
  hosts: MailHosts;
}

const TEXT_CAP = 20_000;
const isoDate = (d: Date | string | undefined): string =>
  d === undefined ? '' : typeof d === 'string' ? d : d.toISOString();
const addr = (
  list: { name?: string | undefined; address?: string | undefined }[] | undefined,
): string =>
  (list ?? [])
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');

function imapQuery(q: SearchQuery): SearchObject {
  return {
    ...(q.text ? { or: [{ subject: q.text }, { body: q.text }] } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.subject ? { subject: q.subject } : {}),
    ...(q.since ? { since: new Date(q.since) } : {}),
    ...(q.unreadOnly ? { seen: false } : {}),
  };
}

/** IMAP for reading and drafts, SMTP for sending. One short connection per call. */
export class ImapMailBackend implements MailBackend {
  constructor(private readonly account: MailAccount) {}

  private async session<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = new ImapFlow({
      host: this.account.hosts.imap.host,
      port: this.account.hosts.imap.port,
      secure: this.account.hosts.imap.secure ?? true,
      auth: { user: this.account.address, pass: this.account.password },
      logger: false,
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => undefined);
    }
  }

  verify(): Promise<void> {
    return this.session(() => Promise.resolve());
  }

  folders(): Promise<{ path: string; role?: string }[]> {
    return this.session(async (c) =>
      (await c.list()).map((f) => ({
        path: f.path,
        ...(f.specialUse ? { role: f.specialUse.replace('\\', '').toLowerCase() } : {}),
      })),
    );
  }

  search(q: SearchQuery): Promise<MessageSummary[]> {
    return this.session(async (c) => {
      const lock = await c.getMailboxLock(q.folder);
      try {
        const found = await c.search(imapQuery(q), { uid: true });
        const uids = found === false ? [] : (found ?? []);
        const newest = uids.slice(-q.limit);
        if (!newest.length) return [];
        const out: MessageSummary[] = [];
        for await (const m of c.fetch(newest, { envelope: true, flags: true }, { uid: true }))
          out.push({
            uid: m.uid,
            date: isoDate(m.envelope?.date),
            from: addr(m.envelope?.from),
            subject: m.envelope?.subject ?? '',
            unread: !m.flags?.has('\\Seen'),
          });
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  read(folder: string, uid: number): Promise<Message | undefined> {
    return this.session(async (c) => {
      const lock = await c.getMailboxLock(folder);
      try {
        const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!m || !m.source) return undefined;
        const p = await simpleParser(m.source);
        const text = (p.text ?? '').trim();
        return {
          uid,
          date: p.date?.toISOString() ?? '',
          from: p.from?.text ?? '',
          to: [p.to]
            .flat()
            .map((a) => a?.text ?? '')
            .join(', '),
          cc: [p.cc]
            .flat()
            .map((a) => a?.text ?? '')
            .join(', '),
          subject: p.subject ?? '',
          unread: !m.flags?.has('\\Seen'),
          text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (clipped)` : text,
          attachments: p.attachments.map((a) => a.filename ?? a.contentType),
        };
      } finally {
        lock.release();
      }
    });
  }

  private compose(mail: OutgoingMail): Promise<Buffer> {
    return new MailComposer({
      from: this.account.address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.cc ? { cc: mail.cc } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
    })
      .compile()
      .build();
  }

  async draft(mail: OutgoingMail): Promise<string> {
    const raw = await this.compose(mail);
    return this.session(async (c) => {
      const drafts = (await c.list()).find((f) => f.specialUse === '\\Drafts')?.path ?? 'Drafts';
      await c.append(drafts, raw, ['\\Draft']);
      return drafts;
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    const { smtp } = this.account.hosts;
    await createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: this.account.address, pass: this.account.password },
    }).sendMail({
      from: this.account.address,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.cc ? { cc: mail.cc } : {}),
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
    });
  }
}
