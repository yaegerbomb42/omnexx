import { appPasswordHelp, EMAIL_ENV } from './email/presets.js';

/** Log in once with what was entered, so a wrong password shows up now, not mid-run. */
async function verifyEmail(values: Readonly<Record<string, string>>): Promise<string | undefined> {
  const address = values[EMAIL_ENV.address] ?? '';
  // Loaded on demand: the mail libraries are only needed by people who connect email.
  const { backendFromEnv, friendlyMailError } = await import('./email/server.js');
  try {
    await backendFromEnv(values).backend.verify();
    return undefined;
  } catch (err) {
    return friendlyMailError(err, address);
  }
}

/**
 * The connector catalog: common apps omnexx can reach through MCP, free to use. Remote entries
 * are vendor-hosted servers; `oauth` ones sign in through the browser with dynamic client
 * registration (checked against each server's OAuth metadata on 2026-10-09). Others take a
 * token, or run a well-known local server with the person's own credentials.
 */
export interface ConnectorNeed {
  key: string;
  /** Where to get it, shown before asking. */
  help: string;
  /** "header": sent as this HTTP header. "env": set as this variable for a local server. */
  target: 'header' | 'env';
  /** A bare token typed for an Authorization header gets "Bearer " in front. */
  bearer?: boolean;
  /** Shown as typed (an address, not a password). */
  visible?: boolean;
  /** Help that depends on what was entered before (the app-password page for that provider). */
  helpFor?: (values: Readonly<Record<string, string>>) => string;
}

/** A yes/no question; yes sets `key` to "1" (e.g. allow sending mail). */
export interface ConnectorQuestion {
  key: string;
  question: string;
}

export interface Connector {
  id: string;
  name: string;
  category: 'mail & calendar' | 'chat' | 'docs & files' | 'work tracking' | 'dev' | 'business';
  url?: string;
  command?: string;
  args?: readonly string[];
  /** Fixed env for a local server (not secret). */
  env?: Readonly<Record<string, string>>;
  auth: 'oauth' | 'token' | 'none';
  /** How signing in works, for the list, when "token" undersells it. */
  how?: string;
  needs?: readonly ConnectorNeed[];
  /** Shown before connecting: setup steps or caveats. */
  note?: string;
  /** Optional settings accepted with --set (custom mail hosts). */
  optional?: readonly string[];
  questions?: readonly ConnectorQuestion[];
  /** Checks the values before anything is saved; resolves to an error to show, or undefined. */
  verify?: (values: Readonly<Record<string, string>>) => Promise<string | undefined>;
}

const oauth = (
  id: string,
  name: string,
  category: Connector['category'],
  url: string,
  note?: string,
): Connector => ({ id, name, category, url, auth: 'oauth', ...(note ? { note } : {}) });

const envNeed = (key: string, help: string): ConnectorNeed => ({ key, help, target: 'env' });
const bearerNeed = (help: string): ConnectorNeed => ({
  key: 'Authorization',
  help,
  target: 'header',
  bearer: true,
});

/** A local npm server: `npx -y <pkg>`, with the tokens it reads from its environment. */
const npx = (
  id: string,
  name: string,
  category: Connector['category'],
  pkg: string,
  needs: readonly ConnectorNeed[] = [],
  note?: string,
): Connector => ({
  id,
  name,
  category,
  command: 'npx',
  args: ['-y', pkg],
  auth: needs.length ? 'token' : 'none',
  ...(needs.length ? { needs } : {}),
  ...(note ? { note } : {}),
});

const GOOGLE_NOTE = [
  'Google needs your own OAuth client (free, about 5 minutes, once):',
  '  1. https://console.cloud.google.com/projectcreate : create a project',
  '  2. APIs & Services > Library: enable Gmail, Calendar, Drive, Docs and Sheets APIs',
  '  3. APIs & Services > OAuth consent screen: External, add yourself as a test user',
  '  4. APIs & Services > Credentials > Create credentials > OAuth client ID > Desktop app',
  '  5. Paste the client ID and secret below. The first time omnexx uses Gmail it opens Google sign-in.',
  'Needs uv (https://docs.astral.sh/uv/) for `uvx`.',
].join('\n');

const google = (id: string, name: string, tools: readonly string[]): Connector => ({
  id,
  name,
  category: 'mail & calendar',
  command: 'uvx',
  args: ['workspace-mcp', '--tools', ...tools],
  env: { OAUTHLIB_INSECURE_TRANSPORT: '1' },
  auth: 'token',
  how: 'your own Google client, adds Calendar and Drive',
  needs: [
    envNeed('GOOGLE_OAUTH_CLIENT_ID', 'the OAuth client ID (…apps.googleusercontent.com)'),
    envNeed('GOOGLE_OAUTH_CLIENT_SECRET', 'the OAuth client secret'),
  ],
  note: GOOGLE_NOTE,
});

const EMAIL: Connector = {
  id: 'email',
  name: 'Email over IMAP: Gmail, Outlook, iCloud, Yahoo, Fastmail… (app password)',
  category: 'mail & calendar',
  command: 'omnexx',
  args: ['serve-email'],
  auth: 'token',
  how: 'email address + app password, easiest',
  needs: [
    { key: EMAIL_ENV.address, help: 'your email address', target: 'env', visible: true },
    {
      key: EMAIL_ENV.password,
      help: 'an app password (not your normal password)',
      helpFor: (v) => appPasswordHelp(v[EMAIL_ENV.address] ?? ''),
      target: 'env',
    },
  ],
  optional: [EMAIL_ENV.imapHost, EMAIL_ENV.imapPort, EMAIL_ENV.smtpHost, EMAIL_ENV.smtpPort],
  questions: [
    {
      key: EMAIL_ENV.allowSend,
      question: 'Let omnexx send mail itself? (no: it saves drafts for you to send)',
    },
  ],
  note: 'Reads, searches and drafts mail with an app password. No Google Cloud setup.',
  verify: verifyEmail,
};

export const CONNECTORS: readonly Connector[] = [
  EMAIL,
  google('google', 'Google Workspace (Gmail, Calendar, Drive, Docs, Sheets)', [
    'gmail',
    'calendar',
    'drive',
    'docs',
    'sheets',
  ]),
  google('gmail', 'Gmail', ['gmail']),
  google('google-calendar', 'Google Calendar', ['calendar']),
  google('google-drive', 'Google Drive, Docs and Sheets', ['drive', 'docs', 'sheets']),
  npx(
    'outlook',
    'Outlook / Microsoft 365 (mail, calendar, OneDrive)',
    'mail & calendar',
    '@softeria/ms-365-mcp-server',
    [],
    'Signs in with a Microsoft device code the first time it is used (community server).',
  ),
  {
    id: 'slack',
    name: 'Slack',
    category: 'chat',
    url: 'https://mcp.slack.com/mcp',
    auth: 'token',
    needs: [
      bearerNeed(
        'a Slack user token (xoxp-…): create an app at https://api.slack.com/apps, add user scopes, install it, copy the User OAuth Token',
      ),
    ],
    note: "Slack's MCP server has no self-service sign-in for outside apps, so it takes a user token.",
  },
  npx(
    'discord',
    'Discord',
    'chat',
    'mcp-discord',
    [
      envNeed(
        'DISCORD_TOKEN',
        'a bot token: https://discord.com/developers/applications > your app > Bot > Reset Token',
      ),
    ],
    'Community server; the bot must be invited to your server.',
  ),
  oauth('notion', 'Notion', 'docs & files', 'https://mcp.notion.com/mcp'),
  oauth('dropbox', 'Dropbox', 'docs & files', 'https://mcp.dropbox.com/mcp'),
  oauth('canva', 'Canva', 'docs & files', 'https://mcp.canva.com/mcp'),
  oauth(
    'figma',
    'Figma',
    'docs & files',
    'https://mcp.figma.com/mcp',
    "Figma may only accept sign-in from approved apps; if it refuses, use the Figma desktop app's local server instead.",
  ),
  npx('airtable', 'Airtable', 'docs & files', 'airtable-mcp-server', [
    envNeed('AIRTABLE_API_KEY', 'a personal access token: https://airtable.com/create/tokens'),
  ]),
  oauth('linear', 'Linear', 'work tracking', 'https://mcp.linear.app/mcp'),
  oauth('atlassian', 'Jira and Confluence', 'work tracking', 'https://mcp.atlassian.com/v1/mcp'),
  oauth('monday', 'monday.com', 'work tracking', 'https://mcp.monday.com/mcp'),
  oauth('todoist', 'Todoist', 'work tracking', 'https://ai.todoist.net/mcp'),
  npx(
    'trello',
    'Trello',
    'work tracking',
    '@delorenj/mcp-server-trello',
    [
      envNeed('TRELLO_API_KEY', 'your API key: https://trello.com/power-ups/admin'),
      envNeed('TRELLO_TOKEN', 'a token generated from that API key page'),
    ],
    'Community server.',
  ),
  {
    id: 'github',
    name: 'GitHub',
    category: 'dev',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    needs: [
      bearerNeed('a personal access token: https://github.com/settings/personal-access-tokens/new'),
    ],
  },
  oauth('gitlab', 'GitLab', 'dev', 'https://gitlab.com/api/v4/mcp'),
  oauth('sentry', 'Sentry', 'dev', 'https://mcp.sentry.dev/mcp'),
  oauth('supabase', 'Supabase', 'dev', 'https://mcp.supabase.com/mcp'),
  oauth(
    'vercel',
    'Vercel',
    'dev',
    'https://mcp.vercel.com',
    'Vercel may only accept sign-in from approved apps.',
  ),
  oauth('cloudflare', 'Cloudflare', 'dev', 'https://bindings.mcp.cloudflare.com/mcp'),
  oauth('stripe', 'Stripe', 'business', 'https://mcp.stripe.com'),
  oauth('paypal', 'PayPal', 'business', 'https://mcp.paypal.com/mcp'),
  oauth(
    'intercom',
    'Intercom',
    'business',
    'https://mcp.intercom.com/mcp',
    'US-hosted Intercom workspaces only.',
  ),
  npx('hubspot', 'HubSpot', 'business', '@hubspot/mcp-server', [
    envNeed(
      'PRIVATE_APP_ACCESS_TOKEN',
      'a private app token: HubSpot > Settings > Integrations > Private Apps',
    ),
  ]),
  npx(
    'shopify-dev',
    'Shopify (developer docs and API schema)',
    'business',
    '@shopify/dev-mcp@latest',
  ),
];

export const findConnector = (id: string): Connector | undefined =>
  CONNECTORS.find((c) => c.id === id.toLowerCase());

/** The MCP server table for a connector; secrets are referenced by name, never inlined. */
/** `given`: the optional settings and answered questions that have a stored value. */
export function connectorServer(
  c: Connector,
  given: readonly string[] = [],
): {
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: Record<string, string>;
  headers_env?: Record<string, string>;
  oauth?: boolean;
} {
  const ref = (n: ConnectorNeed) => [n.key, `secret:${n.key}`] as const;
  const env = {
    ...c.env,
    ...Object.fromEntries((c.needs ?? []).filter((n) => n.target === 'env').map(ref)),
    ...Object.fromEntries(
      [...(c.optional ?? []), ...(c.questions ?? []).map((q) => q.key)]
        .filter((k) => given.includes(k))
        .map((k) => [k, `secret:${k}`]),
    ),
  };
  const headers = Object.fromEntries((c.needs ?? []).filter((n) => n.target === 'header').map(ref));
  return {
    ...(c.command ? { command: c.command, args: c.args ?? [] } : {}),
    ...(c.url ? { url: c.url } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(headers).length ? { headers_env: headers } : {}),
    ...(c.auth === 'oauth' ? { oauth: true } : {}),
  };
}
