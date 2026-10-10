import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ImapMailBackend, type MailBackend, type OutgoingMail } from './backend.js';
import { appPasswordHelp, EMAIL_ENV, resolveHosts } from './presets.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** A mail error a person can act on: a rejected login points at app passwords. */
export function friendlyMailError(err: unknown, address: string): string {
  const e = err as {
    authenticationFailed?: boolean;
    responseText?: string;
    code?: string;
    message?: string;
  };
  const text = `${e.responseText ?? ''} ${e.message ?? ''}`;
  if (
    e.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials|EAUTH|535/i.test(`${text} ${e.code ?? ''}`)
  )
    return `the mail server rejected ${address}'s password. Use an app password, not your normal password: ${appPasswordHelp(address)}`;
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')
    return `could not reach the mail server (${e.code}). For a custom domain, set EMAIL_IMAP_HOST and EMAIL_SMTP_HOST with --set`;
  return e.message ?? String(err);
}

const outgoing = {
  to: z.string().min(3).describe('Recipients, comma-separated'),
  subject: z.string(),
  text: z.string().describe('Plain-text body'),
  cc: z.string().optional(),
  in_reply_to: z.string().optional().describe('Message-ID of the mail being answered'),
};

const toMail = (a: {
  to: string;
  subject: string;
  text: string;
  cc?: string | undefined;
  in_reply_to?: string | undefined;
}): OutgoingMail => ({
  to: a.to,
  subject: a.subject,
  text: a.text,
  ...(a.cc ? { cc: a.cc } : {}),
  ...(a.in_reply_to ? { inReplyTo: a.in_reply_to } : {}),
});

type ToolText = CallToolResult;
const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] });

/** Wrap a tool body: mail errors come back as a readable tool error, never a crash. */
const guarded =
  <A>(address: string, fn: (a: A) => Promise<string>) =>
  async (a: A): Promise<ToolText> => {
    try {
      return text(await fn(a));
    } catch (err) {
      return { ...text(friendlyMailError(err, address)), isError: true };
    }
  };

/** The email tools over one mailbox. Sending is only offered when the person allowed it. */
export function createEmailServer(
  backend: MailBackend,
  opts: { address: string; allowSend: boolean },
): McpServer {
  const server = new McpServer({ name: 'omnexx-email', version: '1.0.0' });
  const g = <A>(fn: (a: A) => Promise<string>) => guarded(opts.address, fn);

  server.registerTool(
    'email_folders',
    { description: `List the folders of ${opts.address}'s mailbox (Inbox, Sent, Drafts, labels).` },
    g(async () =>
      (await backend.folders()).map((f) => `${f.path}${f.role ? ` (${f.role})` : ''}`).join('\n'),
    ),
  );

  server.registerTool(
    'email_search',
    {
      description:
        'Search mail in one folder, newest first. Returns uid, date, sender, subject and whether it is unread; read one with email_read.',
      inputSchema: {
        folder: z.string().default('INBOX'),
        text: z.string().optional().describe('Words in the subject or body'),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        since: z.string().optional().describe('ISO date, e.g. 2026-10-01'),
        unread_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      },
    },
    g(async (a) => {
      const hits = await backend.search({
        folder: a.folder,
        limit: a.limit,
        ...(a.text ? { text: a.text } : {}),
        ...(a.from ? { from: a.from } : {}),
        ...(a.to ? { to: a.to } : {}),
        ...(a.subject ? { subject: a.subject } : {}),
        ...(a.since ? { since: a.since } : {}),
        ...(a.unread_only ? { unreadOnly: true } : {}),
      });
      if (!hits.length) return `no mail in ${a.folder} matches`;
      return hits
        .map(
          (m) =>
            `uid ${m.uid} · ${m.date.slice(0, 16)} · ${m.from} · ${m.subject}${m.unread ? ' · unread' : ''}`,
        )
        .join('\n');
    }),
  );

  server.registerTool(
    'email_read',
    {
      description:
        'Read one message by uid (from email_search): headers, plain-text body, attachment names.',
      inputSchema: { folder: z.string().default('INBOX'), uid: z.number().int().positive() },
    },
    g(async (a) => {
      const m = await backend.read(a.folder, a.uid);
      if (!m) return `no message with uid ${a.uid} in ${a.folder}`;
      return [
        `From: ${m.from}`,
        `To: ${m.to}`,
        ...(m.cc ? [`Cc: ${m.cc}`] : []),
        `Date: ${m.date}`,
        `Subject: ${m.subject}`,
        ...(m.attachments.length ? [`Attachments: ${m.attachments.join(', ')}`] : []),
        '',
        m.text,
      ].join('\n');
    }),
  );

  server.registerTool(
    'email_draft',
    {
      description: `Write an email and save it in ${opts.address}'s Drafts folder for the person to review and send. Prefer this over sending.`,
      inputSchema: outgoing,
    },
    g(async (a) => `saved a draft to ${a.to} in ${await backend.draft(toMail(a))}`),
  );

  if (opts.allowSend)
    server.registerTool(
      'email_send',
      {
        description: `Send an email from ${opts.address} right away. Only when the person asked you to send it; otherwise use email_draft.`,
        inputSchema: outgoing,
      },
      g(async (a) => {
        await backend.send(toMail(a));
        return `sent to ${a.to}`;
      }),
    );

  return server;
}

/** The backend for an account from the env `omnexx connect email` sets up. */
export function backendFromEnv(env: NodeJS.ProcessEnv): { backend: MailBackend; address: string } {
  const address = env[EMAIL_ENV.address]?.trim() ?? '';
  const password = (env[EMAIL_ENV.password] ?? '').replace(/\s+/g, '');
  if (!address || !password)
    throw new Error(
      `${EMAIL_ENV.address} and ${EMAIL_ENV.password} must be set (omnexx connect email)`,
    );
  const hosts = resolveHosts(address, {
    imapHost: env[EMAIL_ENV.imapHost],
    imapPort: env[EMAIL_ENV.imapPort],
    smtpHost: env[EMAIL_ENV.smtpHost],
    smtpPort: env[EMAIL_ENV.smtpPort],
  });
  return { backend: new ImapMailBackend({ address, password, hosts }), address };
}

/** `omnexx serve-email`: the email MCP server over stdio. */
export async function serveEmail(env: NodeJS.ProcessEnv): Promise<void> {
  const { backend, address } = backendFromEnv(env);
  const server = createEmailServer(backend, {
    address,
    allowSend: env[EMAIL_ENV.allowSend] === '1',
  });
  await server.connect(new StdioServerTransport());
}
