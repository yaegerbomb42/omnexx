# Connectors

Connect omnexx to the apps you use, so the agent can read your mail, file a Linear issue or
check Sentry while it works. Every connector is free: omnexx talks to the app's MCP server
directly, with no paid broker in between.

```bash
omnexx connect                 # list the apps and which are connected
omnexx connect notion          # opens your browser to sign in
omnexx connect github --set Authorization=<personal access token>
omnexx disconnect notion       # removes it and forgets the sign-in
```

In the app: `/apps`, `/apps notion`, `/apps github --set Authorization=<token>`.

## Email: the easy way (Gmail, Outlook, iCloud, Yahoo, Fastmail, …)

```bash
omnexx connect email
```

It asks for your address, shows where to make an **app password** for your provider, asks
whether omnexx may send mail itself, and logs in once to check before saving anything.

- Gmail: turn on 2-Step Verification, then make an app password at
  https://myaccount.google.com/apppasswords (some work accounts have this turned off by an admin).
- The agent gets `email_search`, `email_read`, `email_folders` and `email_draft`. Drafts land
  in your Drafts folder for you to review. `email_send` exists only if you said yes to sending.
- Other providers or your own domain: `--set EMAIL_IMAP_HOST=… --set EMAIL_SMTP_HOST=…`
  (ports with `EMAIL_IMAP_PORT` / `EMAIL_SMTP_PORT`). Custom domains default to Google Workspace.
- Mail only. For Calendar and Drive too, use `omnexx connect google` (your own Google client, below).

The server is built into omnexx (`omnexx serve-email`); your password never goes to a
third-party server, only to your mail provider.

## How each kind signs in

| Kind                   | Apps                                                                                                                                                    | What happens                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser sign-in        | Notion, Linear, Jira and Confluence, GitLab, Sentry, Supabase, Vercel, Cloudflare, Stripe, PayPal, Intercom, monday.com, Figma, Canva, Todoist, Dropbox | The vendor hosts the server. omnexx registers itself, opens the sign-in page, and keeps the tokens in `~/.config/omnexx/mcp-oauth.json` (0600). Tokens refresh on their own; a run never stops to ask.          |
| Token                  | GitHub, Slack, Airtable, Trello, Discord, HubSpot                                                                                                       | You paste a token once (where to get it is shown). It goes into `mcp-secrets.json` (0600); the config only names it.                                                                                            |
| Your own Google client | Gmail, Google Calendar, Drive, Docs, Sheets                                                                                                             | Runs the `workspace-mcp` server locally with an OAuth client you create in Google Cloud (free, about 5 minutes; `omnexx connect gmail` prints the steps). Google signs you in the first time the agent uses it. |
| No setup               | Outlook / Microsoft 365, Shopify developer docs                                                                                                         | A local server; Microsoft asks for a device-code sign-in on first use.                                                                                                                                          |

Figma and Vercel may only accept sign-ins from apps they have approved. If one refuses, use
the vendor's local server through `omnexx mcp add`.

## Why Google needs your own client

Google treats Gmail access as a restricted scope. A shared app would need Google's paid
security review before anyone outside a 100-person test list could sign in. Your own client
skips that: it is free and only ever signs in you.

## Anything else

`omnexx mcp add <name>` searches the official MCP registry for every other server.
Connectors are MCP servers under `[mcp.servers.<name>]`, so `omnexx mcp list` and
`omnexx mcp test <name>` work on them too. Remote servers with `oauth = true` take
`oauth_client_id` and `oauth_scope` for servers that need a pre-registered client.
