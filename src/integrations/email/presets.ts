/**
 * Mail server settings by address domain, so connecting takes only an address and an app
 * password. Anything else can be given with EMAIL_IMAP_HOST / EMAIL_SMTP_HOST.
 */
export interface MailHosts {
  /** `secure` false only for local test servers; real mail is always TLS. */
  imap: { host: string; port: number; secure?: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

export interface MailProvider {
  name: string;
  hosts: MailHosts;
  /** Where to make an app password, and what it needs. */
  appPassword: string;
}

const hosts = (imap: string, smtp: string, smtpPort = 465): MailHosts => ({
  imap: { host: imap, port: 993 },
  smtp: { host: smtp, port: smtpPort, secure: smtpPort === 465 },
});

const GMAIL: MailProvider = {
  name: 'Gmail',
  hosts: hosts('imap.gmail.com', 'smtp.gmail.com'),
  appPassword:
    'https://myaccount.google.com/apppasswords (needs 2-Step Verification; a work account admin can turn app passwords off)',
};
const OUTLOOK: MailProvider = {
  name: 'Outlook',
  hosts: hosts('outlook.office365.com', 'smtp-mail.outlook.com', 587),
  appPassword:
    'https://account.live.com/proofs/AppPassword (needs two-step verification; some Microsoft 365 work accounts block IMAP passwords)',
};
const ICLOUD: MailProvider = {
  name: 'iCloud',
  hosts: hosts('imap.mail.me.com', 'smtp.mail.me.com', 587),
  appPassword: 'https://account.apple.com > Sign-In and Security > App-Specific Passwords',
};
const YAHOO: MailProvider = {
  name: 'Yahoo',
  hosts: hosts('imap.mail.yahoo.com', 'smtp.mail.yahoo.com'),
  appPassword: 'https://login.yahoo.com/account/security > Generate app password',
};
const FASTMAIL: MailProvider = {
  name: 'Fastmail',
  hosts: hosts('imap.fastmail.com', 'smtp.fastmail.com'),
  appPassword: 'Fastmail > Settings > Privacy & Security > Integrations > New app password',
};
const AOL: MailProvider = {
  name: 'AOL',
  hosts: hosts('imap.aol.com', 'smtp.aol.com'),
  appPassword: 'https://login.aol.com/account/security > Generate app password',
};
const ZOHO: MailProvider = {
  name: 'Zoho',
  hosts: hosts('imap.zoho.com', 'smtp.zoho.com'),
  appPassword: 'Zoho Accounts > Security > App Passwords',
};
const PROTON_NOTE = 'Proton needs Proton Mail Bridge running; give its host and port with --set.';

const BY_DOMAIN: Record<string, MailProvider> = {
  'gmail.com': GMAIL,
  'googlemail.com': GMAIL,
  'outlook.com': OUTLOOK,
  'hotmail.com': OUTLOOK,
  'live.com': OUTLOOK,
  'msn.com': OUTLOOK,
  'icloud.com': ICLOUD,
  'me.com': ICLOUD,
  'mac.com': ICLOUD,
  'yahoo.com': YAHOO,
  'ymail.com': YAHOO,
  'fastmail.com': FASTMAIL,
  'fastmail.fm': FASTMAIL,
  'aol.com': AOL,
  'zoho.com': ZOHO,
};

export const domainOf = (address: string): string =>
  address.trim().toLowerCase().split('@').pop() ?? '';

/** The provider for an address, or undefined for custom domains (Google Workspace included). */
export function providerFor(address: string): MailProvider | undefined {
  return BY_DOMAIN[domainOf(address)];
}

export interface HostOverrides {
  imapHost?: string | undefined;
  imapPort?: string | undefined;
  smtpHost?: string | undefined;
  smtpPort?: string | undefined;
}

/**
 * Hosts for an address: overrides first, then the known provider. A custom domain without
 * overrides is assumed to be Google Workspace, the most common case; the login check says so if not.
 */
export function resolveHosts(address: string, o: HostOverrides = {}): MailHosts {
  const base = providerFor(address)?.hosts ?? GMAIL.hosts;
  const smtpPort = o.smtpPort ? Number(o.smtpPort) : base.smtp.port;
  return {
    imap: {
      host: o.imapHost ?? base.imap.host,
      port: o.imapPort ? Number(o.imapPort) : base.imap.port,
    },
    smtp: { host: o.smtpHost ?? base.smtp.host, port: smtpPort, secure: smtpPort === 465 },
  };
}

/** One line on where to get an app password for this address. */
export function appPasswordHelp(address: string): string {
  const p = providerFor(address);
  if (p) return `${p.name} app password: ${p.appPassword}`;
  if (domainOf(address) === 'proton.me' || domainOf(address) === 'protonmail.com')
    return PROTON_NOTE;
  return `an app password from your mail provider (Google Workspace: ${GMAIL.appPassword})`;
}

/** Names of the env vars the email server reads (set by `omnexx connect email`). */
export const EMAIL_ENV = {
  address: 'EMAIL_ADDRESS',
  password: 'EMAIL_APP_PASSWORD',
  allowSend: 'EMAIL_ALLOW_SEND',
  imapHost: 'EMAIL_IMAP_HOST',
  imapPort: 'EMAIL_IMAP_PORT',
  smtpHost: 'EMAIL_SMTP_HOST',
  smtpPort: 'EMAIL_SMTP_PORT',
} as const;
